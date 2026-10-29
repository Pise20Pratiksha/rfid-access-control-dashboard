import React, { createContext, useContext, useState, useCallback } from "react";

export interface DetectedTagEvent {
  id: string;
  cardUid: string;
  isRegistered: boolean;
  authorized: boolean;
  direction: "IN" | "OUT";
  deviceId?: number | null;
  deviceName?: string | null;
  plateNumber?: string | null;
  ownerName?: string | null;
  carDetails?: string | null;
  timestamp: string | Date;
}

interface TagDetectionContextType {
  detectedTags: DetectedTagEvent[];
  unregisteredTags: DetectedTagEvent[];
  activeTagForRegistration: DetectedTagEvent | null;
  isRegisterModalOpen: boolean;
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
  openRegisterModal: (tag: DetectedTagEvent | string) => void;
  closeRegisterModal: () => void;
  handleTagDetected: (tag: Omit<DetectedTagEvent, "id"> & { id?: string }) => void;
  dismissUnregisteredTag: (cardUid: string) => void;
  dismissAllUnregisteredTags: () => void;
}

const TagDetectionContext = createContext<TagDetectionContextType | undefined>(undefined);

const SOUND_STORAGE_KEY = "rfid_sound_alert_enabled";

function playAlertSound(isRegistered: boolean) {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();

    if (isRegistered) {
      // Pleasant dual-tone authorized beep
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      const now = ctx.currentTime;
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.setValueAtTime(880, now + 0.08); // A5
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.start(now);
      osc.stop(now + 0.22);
    } else {
      // Urgent high-visibility unregistered alert chime (cyber alert double pulse)
      const now = ctx.currentTime;

      // Pulse 1
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = "triangle";
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.frequency.setValueAtTime(520, now);
      osc1.frequency.setValueAtTime(415, now + 0.08);
      gain1.gain.setValueAtTime(0.2, now);
      gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.16);
      osc1.start(now);
      osc1.stop(now + 0.16);

      // Pulse 2
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = "sawtooth";
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.frequency.setValueAtTime(415, now + 0.18);
      osc2.frequency.setValueAtTime(330, now + 0.26);
      gain2.gain.setValueAtTime(0.15, now + 0.18);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
      osc2.start(now + 0.18);
      osc2.stop(now + 0.38);
    }
  } catch {
    // Ignore browser audio policy restrictions
  }
}

export function TagDetectionProvider({ children }: { children: React.ReactNode }) {
  const [detectedTags, setDetectedTags] = useState<DetectedTagEvent[]>([]);
  const [unregisteredTags, setUnregisteredTags] = useState<DetectedTagEvent[]>([]);
  const [activeTagForRegistration, setActiveTagForRegistration] = useState<DetectedTagEvent | null>(null);
  const [isRegisterModalOpen, setIsRegisterModalOpen] = useState(false);
  const [soundEnabled, setSoundEnabledState] = useState<boolean>(() => {
    return localStorage.getItem(SOUND_STORAGE_KEY) !== "false";
  });
  const recentDetectionsRef = React.useRef<Map<string, number>>(new Map());

  const setSoundEnabled = useCallback((enabled: boolean) => {
    setSoundEnabledState(enabled);
    localStorage.setItem(SOUND_STORAGE_KEY, String(enabled));
  }, []);

  const handleTagDetected = useCallback(
    (tag: Omit<DetectedTagEvent, "id"> & { id?: string }) => {
      const now = Date.now();
      const dedupKey = `${tag.cardUid}-${tag.direction}`;
      const lastTime = recentDetectionsRef.current.get(dedupKey) || 0;

      // Deduplicate if identical tag scan arrived within 1.2 seconds
      if (now - lastTime < 1200) {
        return;
      }
      recentDetectionsRef.current.set(dedupKey, now);

      // Clean up old deduplication keys
      if (recentDetectionsRef.current.size > 100) {
        recentDetectionsRef.current.clear();
      }

      const eventId = tag.id || `${tag.cardUid}-${now}-${Math.random().toString(36).substring(2, 7)}`;
      const newEvent: DetectedTagEvent = {
        ...tag,
        id: eventId,
        timestamp: tag.timestamp || new Date().toISOString(),
      };

      setDetectedTags((prev) => [newEvent, ...prev.slice(0, 49)]);

      if (soundEnabled) {
        playAlertSound(tag.isRegistered);
      }

      if (!tag.isRegistered) {
        // Add to unregistered queue if not already there with same UID, or move to top
        setUnregisteredTags((prev) => {
          const filtered = prev.filter((item) => item.cardUid !== tag.cardUid);
          return [newEvent, ...filtered];
        });
      } else {
        // If it was in the unregistered list before and is now detected as registered, remove it
        setUnregisteredTags((prev) => prev.filter((item) => item.cardUid !== tag.cardUid));
      }
    },
    [soundEnabled]
  );

  const dismissUnregisteredTag = useCallback((cardUid: string) => {
    setUnregisteredTags((prev) => prev.filter((item) => item.cardUid !== cardUid));
  }, []);

  const dismissAllUnregisteredTags = useCallback(() => {
    setUnregisteredTags([]);
  }, []);

  const openRegisterModal = useCallback((tag: DetectedTagEvent | string) => {
    if (typeof tag === "string") {
      setActiveTagForRegistration({
        id: `manual-${Date.now()}`,
        cardUid: tag,
        isRegistered: false,
        authorized: false,
        direction: "IN",
        timestamp: new Date().toISOString(),
      });
    } else {
      setActiveTagForRegistration(tag);
    }
    setIsRegisterModalOpen(true);
  }, []);

  const closeRegisterModal = useCallback(() => {
    setIsRegisterModalOpen(false);
    setActiveTagForRegistration(null);
  }, []);

  return (
    <TagDetectionContext.Provider
      value={{
        detectedTags,
        unregisteredTags,
        activeTagForRegistration,
        isRegisterModalOpen,
        soundEnabled,
        setSoundEnabled,
        openRegisterModal,
        closeRegisterModal,
        handleTagDetected,
        dismissUnregisteredTag,
        dismissAllUnregisteredTags,
      }}
    >
      {children}
    </TagDetectionContext.Provider>
  );
}

export function useTagDetection() {
  const context = useContext(TagDetectionContext);
  if (!context) {
    throw new Error("useTagDetection must be used within a TagDetectionProvider");
  }
  return context;
}
