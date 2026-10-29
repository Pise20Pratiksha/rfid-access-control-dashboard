import "dotenv/config";
import app from "./app";
import { logger } from "./lib/logger";
import { initWebSocketServer } from "./lib/ws";
import { getLocalIpAddress } from "./lib/networkUtils";
import { startDiscoveryService } from "./discoveryService";
import { startMDNSService } from "./mdnsService";
import { startTCPServer } from "./tcpServer";

const port = Number(process.env["PORT"] ?? 5000);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env["PORT"]}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  const lanIP = getLocalIpAddress();
  console.log(`RFID backend running on http://localhost:${port}`);
  logger.info({ port, lanIP }, `Server listening on LAN: http://${lanIP}:${port}`);
});

initWebSocketServer(server);
startMDNSService();
startDiscoveryService();
startTCPServer();

export { app, server, startTCPServer };
