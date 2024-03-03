const { spawn, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const compressing = require("compressing");
const { createWebSocketStream } = require("ws");
const net = require("net");
const fsExtra = require('fs-extra');
const cron = require('node-cron');


// const UUID = process.env.UUID || "ffffffff-ffff-ffff-ffff-ffffffffffff";
const UUID = process.env.UUID || uuidv4()

const port = process.env.PORT || 3000;
const WS_PATH = process.env.WS_PATH || 'lalifeier';

const NEZHA_SERVER = process.env.NEZHA_SERVER;
const NEZHA_PORT = process.env.NEZHA_PORT;
const NEZHA_KEY = process.env.NEZHA_KEY;
const CLOUDFLARE_TOKEN = process.env.CLOUDFLARE_TOKEN;
const DOMAIN = process.env.DOMAIN;

const TLS_SERVER = process.env.TLS_SERVER || 'addons.mozilla.org'; // itunes.apple.com
const WG_ENDPOINT = process.env.WG_ENDPOINT || '162.159.193.10'; // engage.cloudflareclient.com 162.159.193.10
const WG_PRIVATE_KEY = process.env.WG_PRIVATE_KEY || 'YFYOAdbw1bKTHlNNi+aEjBM3BO7unuFC5rOkMRAz9XY=';
const WG_PEER_PUBLIC_KEY = process.env.WG_PEER_PUBLIC_KEY || 'bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=';
const WG_IP6_ADDR = process.env.WG_IP6_ADDR || '2606:4700:110:8a36:df92:102a:9602:fa18';
const WG_RESERVED = process.env.WG_RESERVED || "[78, 135, 76]"

const REALITY_PRIVATE = process.env.REALITY_PRIVATE || 'GL_HdaX-VQVBStvCjmXqcAT-jaO4TH74_fzqEmK-CWU'
const REALITY_PUBLIC = process.env.REALITY_PUBLIC || 'NvbPo4WyN3p4MIQgaz9N6CHzdWEtzem8hcUOqCxfQiU'

const ENABLE_LOG = process.env.ENABLE_LOG;
const LOG_REDIRECT_OPTION = ENABLE_LOG ? '' : '>/dev/null 2>&1 &';

const NEZHA_AGENT = 'mysql'
const CLOUDFLARE = 'nginx'
const SING_BOX = 'redis'

if (process.env.NODE_ENV === 'production' || !ENABLE_LOG) {
  console = console || {};
  console.log = function () { };
}

function uuidv4 () {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
    (c ^ Math.random() * 16 >> c / 4).toString(16)
  );
}

// 获取系统信息
const OS = process.platform;
const ARCH = process.arch === "x64" ? "amd64" : process.arch;

const BIN_DIR = path.join(__dirname, "bin");

// 创建目录
function createDirectory () {
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }
}

// 下载文件
async function downloadFile (url, targetPath) {
  const response = await axios({
    method: "GET",
    url: url,
    responseType: "stream",
  });

  const writer = fs.createWriteStream(targetPath);

  return new Promise((resolve, reject) => {
    response.data.pipe(writer);

    writer.on("finish", () => {
      writer.close(); // 关闭写入流
      resolve(); // 下载完成时解析 Promise
    });

    writer.on("error", (err) => {
      reject(err); // 发生错误时拒绝 Promise
    });
  });
}

// 安装 Nezha 监控
async function installNezha () {
  const toolPath = path.join(BIN_DIR, NEZHA_AGENT);

  if (fs.existsSync(toolPath)) {
    console.log("Nezha agent is already installed.");
    return;
  }

  try {
    if (OS === "freebsd") {
      const downloadUrl =
        "https://github.com/wwxoo/test/releases/download/freebsd/swith";
      await downloadFile(downloadUrl, toolPath);
      await fs.promises.chmod(toolPath, "755");
      console.log("Nezha agent installation completed successfully.");
    } else {
      const AGENT_ZIP = `nezha-agent_${OS}_${ARCH}.zip`;
      const AGENT_ZIP_PATH = path.join(BIN_DIR, AGENT_ZIP);
      const URL = `https://github.com/nezhahq/agent/releases/latest/download/${AGENT_ZIP}`;

      await downloadFile(URL, AGENT_ZIP_PATH);

      // 解压缩文件
      await compressing.zip.uncompress(AGENT_ZIP_PATH, BIN_DIR);

      console.log(`成功解压缩文件: ${AGENT_ZIP_PATH}`);

      await fs.promises.rename(path.join(BIN_DIR, "nezha-agent"), toolPath);

      // 执行权限更改操作
      await fs.promises.chmod(toolPath, "755");
      console.log(`成功更改权限: ${toolPath}`);

      // 删除文件
      await fs.promises.unlink(AGENT_ZIP_PATH);
      console.log(`成功删除文件: ${AGENT_ZIP_PATH}`);

      console.log("Nezha agent installation completed successfully.");
    }
  } catch (error) {
    console.error(
      `An error occurred during Nezha agent installation: ${error}`,
    );
  }
}

async function checkNezhaAgent () {
  if (!NEZHA_SERVER || !NEZHA_PORT || !NEZHA_KEY) {
    console.error(
      "Missing NEZHA_SERVER, NEZHA_PORT, or NEZHA_KEY.Skipping Nezha agent check.",
    );
    return;
  }

  try {
    const { stdout } = await exec(`pgrep -x ${NEZHA_AGENT}`);

    if (stdout) {
      console.log("Nezha agent is already running.");
    } else {
      console.error("Nezha agent is not running. Attempting to start...");
      await startNezhaAgent();
    }
  } catch (error) {
    console.error(`An error occurred during Nezha agent check: ${error}`);
  }
}

async function startNezhaAgent (forceStart = false) {
  if (!NEZHA_SERVER || !NEZHA_PORT || !NEZHA_KEY) {
    console.error(
      "Missing NEZHA_SERVER, NEZHA_PORT, or NEZHA_KEY. Skipping Nezha agent start.",
    );
    return;
  }

  try {
    await stopNezhaAgent(forceStart);

    let NEZHA_TLS = "";
    if (["443", "8443", "2096", "2087", "2083", "2053"].includes(NEZHA_PORT)) {
      NEZHA_TLS = "--tls";
    }

    const command = `${BIN_DIR}/${NEZHA_AGENT} -s ${NEZHA_SERVER}:${NEZHA_PORT} -p ${NEZHA_KEY} ${NEZHA_TLS} --disable-auto-update -d ${LOG_REDIRECT_OPTION}`;
    console.log(`Starting Nezha agent with command: ${command}`);

    const startProcess = spawn(command, [], { shell: true, detached: true });

    startProcess.stdout.on("data", (data) => {
      console.log(`Nezha agent stdout: ${data}`);
    });

    startProcess.stderr.on("data", (data) => {
      console.error(`Nezha agent stderr: ${data}`);
    });

    startProcess.on("error", (err) => {
      console.error(`Failed to start Nezha agent: ${err}`);
    });

    startProcess.unref(); // 让 Node.js 进程不等待子进程的退出
  } catch (error) {
    console.error(`An error occurred during Nezha agent start: ${error}`);
  }
}

async function stopNezhaAgent (forceStart) {
  return new Promise((resolve, reject) => {
    const stopProcess = spawn("pkill", ["-f", NEZHA_AGENT]);

    stopProcess.on("close", (code) => {
      if (code === 0 || forceStart) {
        console.log("Nezha agent stopped successfully.");
        resolve();
      } else {
        reject(
          `Failed to stop existing Nezha agent: Process exited with code ${code}`,
        );
      }
    });

    stopProcess.on("error", (err) => {
      reject(`Failed to stop existing Nezha agent: ${err}`);
    });
  });
}

async function installCloudflared () {
  const toolPath = path.join(BIN_DIR, CLOUDFLARE);

  if (!fs.existsSync(toolPath)) {
    const URL =
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
    await downloadFile(URL, toolPath);
    await fs.promises.chmod(toolPath, "755");

    console.log("cloudflared installation completed successfully.");
  } else {
    console.log("cloudflared is already installed.");
  }
}

async function checkCloudflared () {
  try {
    if (!CLOUDFLARE_TOKEN) {
      console.log("CLOUDFLARE_TOKEN is not set. Skipping Cloudflared check.");
      return;
    }

    const { stdout } = await exec(`pgrep -x ${CLOUDFLARE}`);

    if (stdout) {
      console.log("Cloudflared is already running.");
    } else {
      console.error("Cloudflared is not running. Attempting to start...");
      await startNezhaAgent();
    }
  } catch (error) {
    console.error(`An error occurred during Cloudflared check: ${error}`);
  }
}

async function startCloudflared (forceStart = false) {
  if (!CLOUDFLARE_TOKEN) {
    console.log("CLOUDFLARE_TOKEN is not set. Skipping Cloudflared start.");
    return;
  }

  try {
    await stopCloudflared(forceStart);

    const command = `${BIN_DIR}/${CLOUDFLARE} tunnel --edge-ip-version auto --protocol http2 run --token ${CLOUDFLARE_TOKEN} ${LOG_REDIRECT_OPTION}`;
    console.log(`Starting Cloudflared with command: ${command}`);

    const startProcess = spawn(command, [], { shell: true, detached: true });

    startProcess.stdout.on("data", (data) => {
      console.log(`Cloudflared stdout: ${data}`);
    });

    startProcess.stderr.on("data", (data) => {
      console.error(`Cloudflared stderr: ${data}`);
    });

    startProcess.on("error", (err) => {
      console.error(`Failed to start Cloudflared: ${err}`);
    });

    startProcess.unref(); // 让 Node.js 进程不等待子进程的退出
  } catch (error) {
    console.error(`An error occurred during Cloudflared start: ${error}`);
  }
}

async function stopCloudflared (forceStart) {
  return new Promise((resolve, reject) => {
    const stopProcess = spawn("pkill", ["-f", CLOUDFLARE]);

    stopProcess.on("close", (code) => {
      if (code === 0 || forceStart) {
        console.log("Cloudflared stopped successfully.");
        resolve();
      } else {
        reject(
          `Failed to stop existing Cloudflared: Process exited with code ${code}`,
        );
      }
    });

    stopProcess.on("error", (err) => {
      reject(`Failed to stop existing Cloudflared: ${err}`);
    });
  });
}

async function installSingBox () {
  const singBoxExecutablePath = path.join(BIN_DIR, SING_BOX);

  if (!fs.existsSync(singBoxExecutablePath)) {
    try {
      let { data: { tag_name: latestVersion } } = await axios.get('https://api.github.com/repos/SagerNet/sing-box/releases/latest');
      latestVersion = latestVersion.replace('v', '');
      const releaseFileName = `sing-box-${latestVersion}-linux-${ARCH}`;
      const releaseFilePath = path.join(BIN_DIR, `${releaseFileName}.tar.gz`);

      await downloadFile(`https://github.com/SagerNet/sing-box/releases/download/v${latestVersion}/${releaseFileName}.tar.gz`, releaseFilePath);
      await compressing.tgz.uncompress(releaseFilePath, BIN_DIR);

      const extractedSingBoxPath = path.join(BIN_DIR, releaseFileName, 'sing-box');
      await fsExtra.move(extractedSingBoxPath, singBoxExecutablePath, { overwrite: true });
      await fsExtra.unlink(releaseFilePath);
      await fsExtra.remove(path.join(BIN_DIR, releaseFileName));

      await fsExtra.chmod(singBoxExecutablePath, "755");

      console.log("Sing Box installation completed successfully.");
    } catch (error) {
      console.error('An error occurred during Sing Box installation:', error);
    }
  } else {
    console.log("Sing Box is already installed.");
  }
}

function generateSingBoxConf () {
  const SING_BOX_CONF = `{
    "log": {
        "disabled": false,
        "level": "info",
        "timestamp": true
    },
    "experimental": {
        "cache_file": {
            "enabled": true,
            "store_fakeip": false
        }
    },
    "dns": {
        "servers": [
            {
                "address": "tls://1.1.1.1",
                "strategy": "prefer_ipv4"
            },
            {
                "tag": "warp-dns",
                "address": "tls://1.1.1.1",
                "strategy": "prefer_ipv6"
            }
        ],
        "rules": [
            {
                "inbound": [
                    "vmess-wg-in",
                    "trojan-wg-in"
                ],
                "server": "warp-dns"
            },
            {
                "outbound": [
                    "WARP"
                ],
                "server": "warp-dns"
            }
        ],
        "disable_cache": false
    },
    "inbounds": [
        {
            "type": "vless",
            "sniff": true,
            "sniff_override_destination": true,
            "tag": "xtls-reality-in",
            "listen": "::",
            "listen_port": 8443,
            "users": [
                {
                    "uuid": "${UUID}",
                    "flow": ""
                }
            ],
            "tls": {
                "enabled": true,
                "server_name": "${TLS_SERVER}",
                "reality": {
                    "enabled": true,
                    "handshake": {
                        "server": "${TLS_SERVER}",
                        "server_port": 8443
                    },
                    "private_key": "${REALITY_PRIVATE}",
                    "short_id": [
                        ""
                    ]
                }
            },
            "multiplex": {
                "enabled": true,
                "padding": true,
                "brutal": {
                    "enabled": true,
                    "up_mbps": 1000,
                    "down_mbps": 1000
                }
            }
        },
        {
            "type": "vless",
            "tag": "vless-in",
            "listen": "::",
            "listen_port": 3011,
            "sniff": true,
            "sniff_override_destination": true,
            "transport": {
                "type": "ws",
                "path": "/${WS_PATH}-vl",
                "max_early_data": 2048,
                "early_data_header_name": "Sec-WebSocket-Protocol"
            },
            "multiplex": {
                "enabled": true,
                "padding": true,
                "brutal": {
                    "enabled": true,
                    "up_mbps": 1000,
                    "down_mbps": 1000
                }
            },
            "users": [
                {
                    "uuid": "${UUID}",
                    "flow": ""
                }
            ]
        },
        {
            "type": "vmess",
            "tag": "vmess-in",
            "listen": "::",
            "listen_port": 3012,
            "sniff": true,
            "sniff_override_destination": true,
            "transport": {
                "type": "ws",
                "path": "/${WS_PATH}-vm",
                "max_early_data": 2048,
                "early_data_header_name": "Sec-WebSocket-Protocol"
            },
            "multiplex": {
                "enabled": true,
                "padding": true,
                "brutal": {
                    "enabled": true,
                    "up_mbps": 1000,
                    "down_mbps": 1000
                }
            },
            "users": [
                {
                    "uuid": "${UUID}",
                    "alterId": 0
                }
            ]
        },
        {
            "type": "trojan",
            "tag": "trojan-in",
            "listen": "::",
            "listen_port": 3013,
            "sniff": true,
            "sniff_override_destination": true,
            "transport": {
                "type": "ws",
                "path": "/${WS_PATH}-tr",
                "max_early_data": 2048,
                "early_data_header_name": "Sec-WebSocket-Protocol"
            },
            "multiplex": {
                "enabled": true,
                "padding": true,
                "brutal": {
                    "enabled": true,
                    "up_mbps": 1000,
                    "down_mbps": 1000
                }
            },
            "users": [
                {
                    "password": "{UUID}"
                }
            ]
        },
        {
            "type": "vmess",
            "tag": "vmess-wg-in",
            "listen": "::",
            "listen_port": 3014,
            "sniff": true,
            "sniff_override_destination": true,
            "transport": {
                "type": "ws",
                "path": "/${WS_PATH}-wgvm",
                "max_early_data": 2048,
                "early_data_header_name": "Sec-WebSocket-Protocol"
            },
            "multiplex": {
                "enabled": true,
                "padding": true,
                "brutal": {
                    "enabled": true,
                    "up_mbps": 1000,
                    "down_mbps": 1000
                }
            },
            "users": [
                {
                    "uuid": "${UUID}",
                    "alterId": 0
                }
            ],
            "domain_strategy": "prefer_ipv6"
        },
        {
            "type": "trojan",
            "tag": "trojan-wg-in",
            "listen": "::",
            "listen_port": 3015,
            "sniff": true,
            "sniff_override_destination": true,
            "transport": {
                "type": "ws",
                "path": "/${WS_PATH}-wgtr",
                "max_early_data": 2048,
                "early_data_header_name": "Sec-WebSocket-Protocol"
            },
            "multiplex": {
                "enabled": true,
                "padding": true,
                "brutal": {
                    "enabled": true,
                    "up_mbps": 1000,
                    "down_mbps": 1000
                }
            },
            "users": [
                {
                    "password": "${UUID}"
                }
            ],
            "domain_strategy": "prefer_ipv6"
        }
    ],
    "outbounds": [
        {
            "type": "selector",
            "tag": "proxy",
            "outbounds": [
                "direct",
                "warp",
                "tor"
            ]
        },
        {
            "type": "direct",
            "tag": "direct",
            "domain_strategy": "prefer_ipv4"
        },
        {
            "type": "block",
            "tag": "block"
        },
        {
            "type": "direct",
            "tag": "warp-IPv4-out",
            "detour": "wireguard-out",
            "domain_strategy": "ipv4_only"
        },
        {
            "type": "direct",
            "tag": "warp-IPv6-out",
            "detour": "wireguard-out",
            "domain_strategy": "ipv6_only"
        },
        {
            "type": "direct",
            "tag": "warp-IPv6-prefer-out",
            "detour": "wireguard-out",
            "domain_strategy": "prefer_ipv6"
        },
        {
            "type": "direct",
            "tag": "warp-IPv4-prefer-out",
            "detour": "wireguard-out",
            "domain_strategy": "prefer_ipv4"
        },
        {
            "type": "wireguard",
            "tag": "wireguard-out",
            "server": "${WG_ENDPOINT}",
            "server_port": 2408,
            "local_address": [
                "172.16.0.2/32",
                "${WG_IP6_ADDR}/128"
            ],
            "private_key": "${WG_PRIVATE_KEY}",
            "peer_public_key": "${WG_PEER_PUBLIC_KEY}",
            "reserved": ${WG_RESERVED},
            "mtu": 1280
        },
        {
            "type": "socks",
            "tag": "tor",
            "server": "127.0.0.1",
            "server_port": 9050
        },
        {
            "type": "direct",
            "tag": "warp",
            "detour": "wireguard-out",
            "domain_strategy": "prefer_ipv6"
        }
    ],
    "route": {
        "final": "direct",
        "rules": [
            {
                "inbound": [
                    "vmess-wg",
                    "trojan-wg"
                ],
                "outbound": "warp",
                "clash_mode": "rule"
            },
            {
                "rule_set": "geosite-tor",
                "outbound": "tor"
            },
            {
                "rule_set": [
                    "geosite-openai",
                    "geosite-netflix"
                ],
                "outbound": "warp-IPv6-out"
            },
            {
                "rule_set": "geosite-disney",
                "outbound": "warp-IPv6-out"
            }
        ],
        "rule_set": [
            {
                "tag": "geosite-openai",
                "type": "remote",
                "format": "binary",
                "url": "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite/openai.srs",
                "download_detour": "direct"
            },
            {
                "tag": "geosite-netflix",
                "type": "remote",
                "format": "binary",
                "url": "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite/netflix.srs",
                "download_detour": "direct"
            },
            {
                "tag": "geosite-disney",
                "type": "remote",
                "format": "binary",
                "url": "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite/disney.srs",
                "download_detour": "direct"
            },
            {
                "tag": "geosite-tor",
                "type": "remote",
                "format": "binary",
                "url": "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite/tor.srs",
                "download_detour": "direct"
            }
        ]
    }
  }`;

  try {
    fsExtra.outputFileSync('sb.json', SING_BOX_CONF);
  } catch (err) {
    // console.error(err);
  }
}

async function startSingBox (forceStart = false) {
  try {
    await stopSingBox(forceStart);

    const command = `${BIN_DIR}/${SING_BOX} run -c sb.json ${LOG_REDIRECT_OPTION}`;
    console.log(`Starting Sing Box with command: ${command}`);

    const startProcess = spawn(command, [], { shell: true, detached: true });

    startProcess.stdout.on("data", (data) => {
      console.log(`Sing Box stdout: ${data}`);
    });

    startProcess.stderr.on("data", (data) => {
      console.error(`Sing Box stderr: ${data}`);
    });

    startProcess.on("error", (err) => {
      console.error(`Failed to start Sing Box: ${err}`);
    });

    startProcess.unref(); // 让 Node.js 进程不等待子进程的退出
  } catch (error) {
    console.error(`An error occurred during Sing Box start: ${error}`);
  }
}

async function stopSingBox (forceStart) {
  return new Promise((resolve, reject) => {
    const stopProcess = spawn("pkill", ["-f", SING_BOX]);

    stopProcess.on("close", (code) => {
      if (code === 0 || forceStart) {
        console.log("Sing Box stopped successfully.");
        resolve();
      } else {
        reject(
          `Failed to stop existing Sing Box: Process exited with code ${code}`,
        );
      }
    });

    stopProcess.on("error", (err) => {
      reject(`Failed to stop existing Sing Box: ${err}`);
    });
  });
}

async function main () {
  try {
    createDirectory();

    if (NEZHA_SERVER && NEZHA_PORT && NEZHA_KEY) {
      await installNezha();

      await startNezhaAgent(true);
    }

    if (CLOUDFLARE_TOKEN) {
      await installCloudflared();

      await startCloudflared(true);
    }

    await installSingBox();

    generateSingBoxConf();

    await startSingBox(true);

    // setInterval(
    //   async () => {
    //     await checkNezhaAgent();

    //     await checkCloudflared();
    //   },
    //   3 * 60 * 1000,
    // );
  } catch (error) {
    console.error(`An error occurred in the main function: ${error}`);
  }
}

function init () {
  main();

  // 监听 SIGINT 信号（Ctrl+C）和进程退出事件
  process.on("SIGINT", async () => {
    console.log(
      "Received SIGINT signal. Stopping Nezha agent and Cloudflared and Sing Box...",
    );
    try {
      await Promise.all([stopNezhaAgent(), stopCloudflared(), stopSingBox()]);
      console.log("Nezha agent and Cloudflared and Sing Box stopped.");
    } catch (error) {
      console.error(`Error stopping Nezha agent and Cloudflared and Sing Box: ${error}`);
    }
    console.log("Exiting Node.js process.");
    process.exit(0); // 退出 Node.js 进程
  });

  // 监听进程退出事件
  process.on("exit", () => {
    console.log("Node.js process is exiting.");
  });

  const fastify = require("fastify")({ logger: true });

  fastify.get("/", async (request, reply) => {
    return { hello: "world" };
  });

  const proxy = require('@fastify/http-proxy');

  fastify.register(proxy, {
    upstream: "http://127.0.0.1:3011",
    prefix: `/${WS_PATH}-vl`,
    rewritePrefix: `/${WS_PATH}-vl`,
    websocket: true,
    replyOptions: { rewriteRequestHeaders: (headers) => headers },
  });
  fastify.register(proxy, {
    upstream: "http://127.0.0.1:3012",
    prefix: `/${WS_PATH}-vm`,
    rewritePrefix: `/${WS_PATH}-vm`,
    websocket: true,
    replyOptions: { rewriteRequestHeaders: (headers) => headers },
  });
  fastify.register(proxy, {
    upstream: "http://127.0.0.1:3013",
    prefix: `/${WS_PATH}-tr`,
    rewritePrefix: `/${WS_PATH}-tr`,
    websocket: true,
    replyOptions: { rewriteRequestHeaders: (headers) => headers },
  });
  fastify.register(proxy, {
    upstream: "http://127.0.0.1:3014",
    prefix: `/${WS_PATH}-wgvm`,
    rewritePrefix: `/${WS_PATH}-wgvm`,
    websocket: true,
    replyOptions: { rewriteRequestHeaders: (headers) => headers },
  });
  fastify.register(proxy, {
    upstream: "http://127.0.0.1:3015",
    prefix: `/${WS_PATH}-wgtr`,
    rewritePrefix: `/${WS_PATH}-wgtr`,
    websocket: true,
    replyOptions: { rewriteRequestHeaders: (headers) => headers },
  });

  function getDomainPrefix (hostname) {
    return hostname.split('.')[0];
  }

  fastify.get("/sub", async (request, reply) => {
    const NODE_NAME = require("os").hostname();

    let hostname = request.hostname;
    if (request.headers["x-forwarded-host"]) {
      hostname = request.headers["x-forwarded-host"];
    }

    const DOMAIN = process.env.DOMAIN ? process.env.DOMAIN.split(",") : [hostname];

    const CDN_DOMAIN = [
      ...DOMAIN,
      "cdn.lalifeier.cloudns.org",
      "ip.sb",
      "time.is",
      "www.visa.com.hk",
      "singapore.com",
      "japan.com",
      "icook.tw",
    ];

    // const metaInfo = execSync(
    //     'curl -s https://speed.cloudflare.com/meta | awk -F\\" \'{print $26"-"$18}\' | sed -e \'s/ /_/g\'',
    //     { encoding: 'utf-8' }
    // );
    // const ISP = metaInfo.trim();

    let data = [];
    for (const HOST of DOMAIN) {
      for (const CFIP of CDN_DOMAIN) {
        const vless = `vless://${UUID}@${CFIP}:443?encryption=none&security=tls&sni=${HOST}&type=ws&host=${HOST}&path=%2F${WS_PATH}-vl#${CFIP}-Vl`;

        const VMESS = {
          v: "2",
          ps: `${CFIP}-Vm`,
          add: CFIP,
          port: "443",
          id: UUID,
          aid: "0",
          scy: "none",
          net: "ws",
          type: "none",
          host: HOST,
          path: `/${WS_PATH}-vm`,
          tls: "tls",
          sni: HOST,
          alpn: "",
        };
        const vmess = `vmess://${Buffer.from(JSON.stringify(VMESS)).toString("base64")}`;
        const trojan = `trojan://${UUID}@${CFIP}:443?security=tls&sni=${HOST}&type=ws&host=${HOST}&path=%2F${WS_PATH}-tr#${CFIP}-Tr`;

        const WG_VMESS = {
          v: "2",
          ps: `${CFIP}-WgVm`,
          add: CFIP,
          port: "443",
          id: UUID,
          aid: "0",
          scy: "none",
          net: "ws",
          type: "none",
          host: HOST,
          path: `/${WS_PATH}-wgvm`,
          tls: "tls",
          sni: HOST,
          alpn: "",
        };
        const wg_vmess = `vmess://${Buffer.from(JSON.stringify(WG_VMESS)).toString("base64")}`;
        const wg_trojan = `trojan://${UUID}@${CFIP}:443?security=tls&sni=${HOST}&type=ws&host=${HOST}&path=%2F${WS_PATH}-wgtr#${CFIP}-WgTr`;

        data.push(`${vless}`);
        data.push(`${vmess}`);
        data.push(`${trojan}`);

        data.push(`${wg_vmess}`);
        data.push(`${wg_trojan}`);
      }

      // const vless_reality =`vless://${UUID}@${CFIP}:8443?security=reality&sni=${TLS_SERVER}&fp=chrome&pbk=${REALITY_PUBLIC}&type=tcp&encryption=none#${SERVER}%20vless-reality-vision`
      // data.push(`${vless_reality}`);
    }
    const data_str = data.join("\n");
    return Buffer.from(data_str).toString("base64");
  });
  return fastify;
}

if (require.main === module) {
  const app = init();

  app.listen({ port }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`server listening on ${address}`);
  });
} else {
  module.exports = init;
}
