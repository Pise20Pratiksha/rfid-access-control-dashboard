import "dotenv/config";
import app from "./app";
import { logger } from "./lib/logger";
import { initWebSocketServer } from "./lib/ws";
import { getLocalIpAddress } from "./lib/networkUtils";
import { assertProductionCredentials } from "./lib/auth";
import { startDiscoveryService } from "./discoveryService";
import { startMDNSService } from "./mdnsService";
import { startTCPServer } from "./tcpServer";

const port = Number(process.env["PORT"] ?? 8080);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env["PORT"]}"`);
}

assertProductionCredentials();

// LAN-only transports (raw TCP :5001, UDP broadcast discovery, mDNS) cannot work
// on a cloud host that exposes a single HTTPS port. Cloud controllers connect to
// wss://<host>/api/device-ws instead. Set ENABLE_LAN_SERVICES=false in the cloud.
const lanServices = (process.env["ENABLE_LAN_SERVICES"] ?? "true") !== "false";

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  if (lanServices) {
    const lanIP = getLocalIpAddress();
    logger.info({ port, lanIP }, `Server listening on LAN: http://${lanIP}:${port}`);
  } else {
    logger.info({ port }, "Server listening (cloud mode, LAN services disabled)");
  }
});

initWebSocketServer(server);

if (lanServices) {
  startMDNSService();
  startDiscoveryService();
  startTCPServer();
}
