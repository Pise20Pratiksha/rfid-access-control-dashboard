import mDNS from "multicast-dns";
import { getLocalIpAddress } from "./lib/networkUtils";
import { logger } from "./lib/logger";

const APP_HOSTNAME = (process.env.APP_HOSTNAME ?? "rfid-app.local").toLowerCase();
const HOST_NAME_WITHOUT_LOCAL = APP_HOSTNAME.replace(/\.local$/, "");
const TCP_PORT = Number(process.env.TCP_PORT ?? 5001);

let mdnsInstance: any = null;
let lastAnnouncedIp = "";

/**
 * Starts the native RFC 6762 Multicast DNS service.
 * Responds to queries for the configured hostname (e.g., `rfid-app.local` or `rfid-app`)
 * with the current local LAN IP address, without hardcoding IP addresses.
 * Also announces the `_rfid-access._tcp` service and SRV/TXT records.
 */
export function startMDNSService(): void {
  if (mdnsInstance) {
    logger.warn("[mDNS] Service is already running");
    return;
  }

  const currentLanIP = getLocalIpAddress();
  lastAnnouncedIp = currentLanIP;

  try {
    const mdns = mDNS();

    mdns.on("warning", (err: any) => {
      logger.warn({ err: err.message }, "[mDNS] Warning in multicast DNS");
    });

    mdns.on("error", (err: any) => {
      logger.warn({ err: err.message }, "[mDNS] Multicast DNS socket warning");
    });

    mdns.on("query", (query: any) => {
      const questions = query.questions || [];
      const answers: any[] = [];
      const additionals: any[] = [];

      const currentIp = getLocalIpAddress();

      for (const q of questions) {
        const qName = (q.name || "").toLowerCase();
        const qType = q.type;

        // Check if query is for our hostname (e.g. "rfid-app.local" or "rfid-app")
        const matchesHostname =
          qName === APP_HOSTNAME ||
          qName === HOST_NAME_WITHOUT_LOCAL ||
          qName === `${HOST_NAME_WITHOUT_LOCAL}.local`;

        if (matchesHostname && (qType === "A" || qType === "ANY")) {
          logger.info(`[mDNS] Received "${qType}" query for "${qName}". Answering with IP ${currentIp}`);
          answers.push({
            name: APP_HOSTNAME,
            type: "A",
            ttl: 120,
            data: currentIp,
          });
        }

        // Check if query is for DNS-SD service "_rfid-access._tcp.local"
        if (qName.includes("_rfid-access") && (qType === "PTR" || qType === "SRV" || qType === "ANY" || qType === "TXT")) {
          logger.info(`[mDNS] Received service query for "${qName}". Answering with port ${TCP_PORT}`);
          answers.push({
            name: "_rfid-access._tcp.local",
            type: "PTR",
            ttl: 120,
            data: `${HOST_NAME_WITHOUT_LOCAL}._rfid-access._tcp.local`,
          });
          additionals.push({
            name: `${HOST_NAME_WITHOUT_LOCAL}._rfid-access._tcp.local`,
            type: "SRV",
            ttl: 120,
            data: {
              port: TCP_PORT,
              weight: 0,
              priority: 0,
              target: APP_HOSTNAME,
            },
          });
          additionals.push({
            name: `${HOST_NAME_WITHOUT_LOCAL}._rfid-access._tcp.local`,
            type: "TXT",
            ttl: 120,
            data: ["version=2.1.0", "service=rfid-access-server", "deviceId=RFID-SERVER-CORE"],
          });
          additionals.push({
            name: APP_HOSTNAME,
            type: "A",
            ttl: 120,
            data: currentIp,
          });
        }
      }

      if (answers.length > 0) {
        mdns.respond({
          answers,
          additionals: additionals.length > 0 ? additionals : undefined,
        });
      }
    });

    mdnsInstance = mdns;
    logger.info(
      `[mDNS] Multicast DNS responder active. Resolving "${APP_HOSTNAME}" -> ${currentLanIP} (Port: ${TCP_PORT})`
    );
  } catch (err: any) {
    logger.warn({ err: err.message }, "[mDNS] Failed to initialize mDNS responder");
  }
}

/**
 * Checks if the host LAN IP changed and updates announcements
 */
export function checkAndUpdateHostIp(): void {
  const currentIp = getLocalIpAddress();
  if (currentIp !== lastAnnouncedIp) {
    logger.info(`[mDNS] Host LAN IP changed: ${lastAnnouncedIp} -> ${currentIp}. Updating mDNS records.`);
    lastAnnouncedIp = currentIp;

    if (mdnsInstance) {
      // Send gratuitous mDNS response to notify the network immediately of the new IP
      mdnsInstance.respond({
        answers: [
          {
            name: APP_HOSTNAME,
            type: "A",
            ttl: 120,
            data: currentIp,
          },
        ],
      });
    }
  }
}

/**
 * Cleanly stops mDNS service
 */
export function stopMDNSService(): void {
  if (mdnsInstance) {
    try {
      mdnsInstance.destroy();
    } catch {}
    mdnsInstance = null;
    logger.info("[mDNS] Service stopped");
  }
}
