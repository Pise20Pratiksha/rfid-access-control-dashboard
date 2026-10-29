import { useEffect, useState } from "react";
import { useListEspDevices, type EspDevice } from "@workspace/api-client-react";

// A firmware heartbeat (ping) arrives well within this window while the ESP32 is connected.
const STALE_AFTER_MS = 90_000;

/**
 * True only while an ESP32 gate reader is connected to the server and reporting.
 * The device list is refreshed by websocket events (see use-live-socket); the clock tick expires stale heartbeats.
 */
export function useFirmwareConnected(): boolean {
  const { data: devices } = useListEspDevices();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(t);
  }, []);

  return Boolean(
    Array.isArray(devices) && devices.some(
      (d: EspDevice) =>
        d.status === "online" &&
        d.lastSeenAt &&
        now - new Date(d.lastSeenAt).getTime() < STALE_AFTER_MS,
    ),
  );
}
