import dgram from "dgram";
import {
  getLocalIpAddress,
  getAllLocalIpv4Addresses,
  isLocalAddress,
  getBroadcastAddresses,
} from "./lib/networkUtils";
import { registerOrUpdateDevice } from "./deviceRegistry";
import { logger } from "./lib/logger";

const UDP_DISCOVERY_PORT = Number(process.env.UDP_DISCOVERY_PORT ?? 5002);
const TCP_PORT = Number(process.env.TCP_PORT ?? 5001);
const BEACON_INTERVAL_MS = 5000;
const SERVER_PERMANENT_ID = process.env.SERVER_DEVICE_ID ?? "RFID-SERVER-CORE";

let udpSocket: dgram.Socket | null = null;
let beaconTimer: NodeJS.Timeout | null = null;
let lastAnnouncedIp = "";

/**
 * Starts the robust UDP discovery service.
 * - Listens for discovery probes from ESP32 gate devices on the local LAN.
 * - Responds with the server's current LAN IP and TCP port.
 * - Discards any self-broadcasts to prevent infinite reflection loops.
 * - Broadcasts periodic beacons so devices auto-discover on boot or after DHCP changes.
 */
export function startDiscoveryService(): void {
  if (udpSocket) {
    logger.warn("[Discovery] UDP discovery service is already running");
    return;
  }

  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("error", (err) => {
    logger.error({ err: err.message }, "[Discovery] UDP socket error occurred");
  });

  socket.on("listening", () => {
    try {
      socket.setBroadcast(true);
    } catch (err: any) {
      logger.warn({ err: err.message }, "[Discovery] Could not set broadcast flag on UDP socket");
    }

    const address = socket.address();
    const lanIP = getLocalIpAddress();
    lastAnnouncedIp = lanIP;

    logger.info(
      `[Discovery] UDP discovery listening on port ${address.port}. LAN IP: ${lanIP}, TCP Port: ${TCP_PORT}`
    );

    startBeaconBroadcast();
  });

  socket.on("message", (msg, rinfo) => {
    const senderIp = rinfo.address.replace("::ffff:", "").trim();

    // CRITICAL BUGFIX: Discard packets originated by the server itself!
    // When broadcasting to 255.255.255.255, the socket on the same machine receives
    // its own packet. If we respond to our own packet, an infinite loop ensues!
    if (isLocalAddress(senderIp)) {
      return;
    }

    const rawText = msg.toString("utf8").trim();
    if (!rawText) return;

    let parsed: any = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Plain string probe fallback
      if (rawText.includes("DISCOVER_SERVER")) {
        parsed = { cmd: "DISCOVER_SERVER", deviceId: "ESP32 Gate Logger" };
      } else {
        return;
      }
    }

    const msgType = (parsed.type || parsed.cmd || "").toLowerCase();

    // 1. Never reply to server beacons or responses (prevents echo storms)
    if (msgType === "server_beacon" || msgType === "discovery_response") {
      return;
    }

    // 2. Handle incoming client discovery probe
    const isProbe =
      msgType === "discovery_probe" ||
      msgType === "discover_server" ||
      msgType === "discover" ||
      parsed.service === "rfid-access-server-client";

    if (isProbe) {
      const currentLanIP = getLocalIpAddress();
      const deviceId =
        parsed.deviceId || parsed.client || parsed.mac || `ESP32-GATE-${senderIp.replace(/\./g, "")}`;
      const deviceName = parsed.name || parsed.deviceName || "ESP32 Gate Logger";
      const macAddress = parsed.mac || parsed.macAddress;
      const firmwareVersion = parsed.version || parsed.firmwareVersion || "2.1.0";

      logger.info(
        `[Discovery] Received discovery probe from "${deviceId}" (${deviceName}) at ${senderIp}:${rinfo.port}`
      );

      // Dynamically resolve & register device in registry
      registerOrUpdateDevice({
        deviceId,
        name: deviceName,
        ipAddress: senderIp,
        port: rinfo.port,
        macAddress,
        firmwareVersion,
        status: "online",
      });

      const responsePayload = JSON.stringify({
        type: "discovery_response",
        service: "rfid-access-server",
        serverId: SERVER_PERMANENT_ID,
        serverName: "Vehicle RFID Access Server",
        host: currentLanIP,
        tcpPort: TCP_PORT,
        udpPort: UDP_DISCOVERY_PORT,
        authRequired: true,
        version: "2.1.0",
        serverTime: new Date().toISOString(),
      });

      const responseBuffer = Buffer.from(responsePayload + "\n");

      // Reply directly to the sender's unicast IP and port
      socket.send(responseBuffer, 0, responseBuffer.length, rinfo.port, rinfo.address, (err) => {
        if (err) {
          logger.error(
            { err: err.message, clientIp: rinfo.address },
            "[Discovery] Failed to send unicast response to client"
          );
        } else {
          logger.info(
            `[Discovery] Replied to ${rinfo.address}:${rinfo.port} -> host=${currentLanIP}, port=${TCP_PORT}`
          );
        }
      });
      return;
    }

    // 3. Handle device periodic status announcement
    if (msgType === "device_announcement" || msgType === "device_presence") {
      const deviceId = parsed.deviceId || `ESP32-GATE-${senderIp.replace(/\./g, "")}`;
      registerOrUpdateDevice({
        deviceId,
        name: parsed.name || "ESP32 Gate Logger",
        ipAddress: senderIp,
        port: rinfo.port,
        macAddress: parsed.mac,
        firmwareVersion: parsed.version,
        nvsRecordsCount: parsed.nvsCount,
        status: "online",
      });
      return;
    }
  });

  try {
    socket.bind(UDP_DISCOVERY_PORT, "0.0.0.0");
    udpSocket = socket;
  } catch (err: any) {
    logger.error({ err: err.message }, `[Discovery] Failed to bind UDP port ${UDP_DISCOVERY_PORT}`);
  }
}

/**
 * Periodically broadcasts a beacon announcement on the local subnet.
 * This guarantees that when an ESP32 boots up or when router DHCP assigns
 * a new IP address to either the server or ESP32, the devices automatically
 * discover each other within seconds without any user intervention.
 */
function startBeaconBroadcast(): void {
  if (beaconTimer) {
    clearInterval(beaconTimer);
  }

  beaconTimer = setInterval(() => {
    if (!udpSocket) return;

    const currentLanIP = getLocalIpAddress();
    if (currentLanIP !== lastAnnouncedIp) {
      logger.info(
        `[Discovery] Server LAN IP changed dynamically from ${lastAnnouncedIp} to ${currentLanIP} (DHCP update). Updating announcements.`
      );
      lastAnnouncedIp = currentLanIP;
    }

    const beacon = JSON.stringify({
      type: "server_beacon",
      service: "rfid-access-server",
      serverId: SERVER_PERMANENT_ID,
      serverName: "Vehicle RFID Access Server",
      host: currentLanIP,
      tcpPort: TCP_PORT,
      udpPort: UDP_DISCOVERY_PORT,
      authRequired: true,
      version: "2.1.0",
      timestamp: Date.now(),
    });

    const buffer = Buffer.from(beacon + "\n");
    const targets = getBroadcastAddresses();

    for (const bcastIp of targets) {
      udpSocket.send(buffer, 0, buffer.length, UDP_DISCOVERY_PORT, bcastIp, (err) => {
        if (err) {
          logger.debug({ err: err.message, target: bcastIp }, "[Discovery] Beacon broadcast error");
        }
      });
    }
  }, BEACON_INTERVAL_MS);
}

/**
 * Stops the UDP discovery service and cleans up timers.
 */
export function stopDiscoveryService(): void {
  if (beaconTimer) {
    clearInterval(beaconTimer);
    beaconTimer = null;
  }
  if (udpSocket) {
    try {
      udpSocket.close();
    } catch {}
    udpSocket = null;
    logger.info("[Discovery] UDP discovery service stopped");
  }
}
