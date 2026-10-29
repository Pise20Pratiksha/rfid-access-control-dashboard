import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTagDetection } from "@/context/tag-detection-context";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

export function useLiveSocket() {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const queryClient = useQueryClient();
  const { handleTagDetected } = useTagDetection();

  // Keep a ref to handleTagDetected so connect callback doesn't rebind unnecessarily
  const handleTagDetectedRef = useRef(handleTagDetected);
  useEffect(() => {
    handleTagDetectedRef.current = handleTagDetected;
  }, [handleTagDetected]);

  useEffect(() => {
    let mounted = true;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/api/ws`;

      setStatus(prev => (prev === "disconnected" ? "reconnecting" : "connecting"));
      
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mounted) return;
        setStatus("connected");
        // Clear any reconnect timeout
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        if (!mounted) return;
        try {
          const data = JSON.parse(event.data);
          
          let eventType = data.type;
          // Normalize legacy event types to match expectations
          if (eventType === "access-log") eventType = "access_log_created";
          if (eventType === "device-created") eventType = "esp_device_created";
          if (eventType === "device-updated") eventType = "esp_device_updated";
          if (eventType === "device-deleted") eventType = "esp_device_deleted";
          if (eventType === "device-status") eventType = "esp_device_heartbeat";

          if (eventType === "tag_detected" && data.payload) {
            handleTagDetectedRef.current(data.payload);
          }

          if (eventType === "access_log_created" && data.payload) {
            const log = data.payload;
            // Invalidate lists to fetch the latest log
            queryClient.invalidateQueries({ queryKey: ["/api/access-logs"] });
            queryClient.invalidateQueries({ queryKey: ["/api/analytics/summary"] });
            queryClient.invalidateQueries({ queryKey: ["/api/analytics/daily"] });
            
            // Forward to tag detection system (handles de-duplication internally)
            handleTagDetectedRef.current({
              cardUid: log.cardUid,
              isRegistered: log.isRegistered ?? log.authorized,
              authorized: Boolean(log.authorized),
              direction: log.direction || "IN",
              deviceId: log.deviceId,
              deviceName: log.deviceName,
              plateNumber: log.plateNumber,
              ownerName: log.ownerName,
              carDetails: log.carDetails,
              timestamp: log.timestamp || new Date().toISOString(),
            });
          }

          if (eventType?.startsWith("esp_device_") || eventType === "esp_device_heartbeat") {
            queryClient.invalidateQueries({ queryKey: ["/api/esp-devices"] });
          }

          if (eventType?.startsWith("vehicle_")) {
            queryClient.invalidateQueries({ queryKey: ["/api/vehicles"] });
          }

          if (eventType?.startsWith("rfid_card_")) {
            queryClient.invalidateQueries({ queryKey: ["/api/rfid-cards"] });
          }
          
        } catch (err) {
          console.error("Failed to parse websocket message", err);
        }
      };

      ws.onclose = () => {
        if (!mounted) return;
        setStatus("disconnected");
        // Auto-reconnect after 3 seconds
        reconnectTimeoutRef.current = window.setTimeout(connect, 3000);
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
      };
    }

    connect();

    return () => {
      mounted = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [queryClient]);

  return { status };
}
