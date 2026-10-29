import os from "os";

// Interface name patterns that indicate virtual adapters (VPN, Hyper-V,
// VMware/VirtualBox, WSL, Docker) rather than a physical WiFi/Ethernet NIC.
const VIRTUAL_IFACE_PATTERNS = [
  /vEthernet/i,
  /Virtual/i,
  /VMware/i,
  /VirtualBox/i,
  /Hyper-V/i,
  /WSL/i,
  /Docker/i,
  /Loopback/i,
  /Tailscale/i,
  /ZeroTier/i,
  /TAP/i,
  /TUN/i,
];

/**
 * Returns true if the address looks like a typical private home/office LAN IP
 */
function isLikelyRealLan(address: string): boolean {
  return address.startsWith("192.168.") || address.startsWith("10.") || address.startsWith("172.");
}

/**
 * Resolves the primary local LAN IPv4 address of this machine (e.g. 192.168.0.107),
 * deliberately ignoring virtual switch adapters like VMware or WSL.
 */
export function getLocalIpAddress(): string {
  const interfaces = os.networkInterfaces();
  const candidates: { name: string; address: string }[] = [];

  for (const name of Object.keys(interfaces)) {
    const interfaceList = interfaces[name];
    if (!interfaceList) continue;
    for (const netInterface of interfaceList) {
      if (netInterface.family === "IPv4" && !netInterface.internal) {
        candidates.push({ name, address: netInterface.address });
      }
    }
  }

  // 1. Prefer a real-looking LAN IP on a non-virtual adapter (e.g. Wi-Fi, Ethernet)
  const best = candidates.find(
    (c) => isLikelyRealLan(c.address) && !VIRTUAL_IFACE_PATTERNS.some((p) => p.test(c.name))
  );
  if (best) return best.address;

  // 2. Fall back to any non-virtual adapter
  const fallback = candidates.find(
    (c) => !VIRTUAL_IFACE_PATTERNS.some((p) => p.test(c.name))
  );
  if (fallback) return fallback.address;

  // 3. Last resort: whatever was found first
  if (candidates.length > 0) return candidates[0].address;

  return "127.0.0.1";
}

/**
 * Returns ALL IPv4 addresses assigned to any network adapter on this machine.
 * This includes Wi-Fi, Ethernet, VMware, VirtualBox, WSL, and loopback.
 * Used by discovery listeners to immediately discard packets emitted by this machine itself,
 * completely preventing self-amplifying packet loops.
 */
export function getAllLocalIpv4Addresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: Set<string> = new Set(["127.0.0.1", "0.0.0.0"]);

  for (const name of Object.keys(interfaces)) {
    const interfaceList = interfaces[name];
    if (!interfaceList) continue;
    for (const netInterface of interfaceList) {
      if (netInterface.family === "IPv4") {
        addresses.add(netInterface.address);
      }
    }
  }

  return Array.from(addresses);
}

/**
 * Checks if a given IP address belongs to the local machine
 */
export function isLocalAddress(ip: string): boolean {
  if (!ip) return false;
  const cleanIp = ip.replace("::ffff:", "").trim();
  const allLocal = getAllLocalIpv4Addresses();
  return allLocal.includes(cleanIp) || cleanIp === "127.0.0.1" || cleanIp === "::1";
}

/**
 * Calculate directed broadcast address for a given IP and netmask.
 * Defaults to 255.255.255.255 if cannot be determined.
 */
export function getBroadcastAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const broadcasts: Set<string> = new Set(["255.255.255.255"]);

  for (const name of Object.keys(interfaces)) {
    if (VIRTUAL_IFACE_PATTERNS.some((p) => p.test(name))) continue;

    const interfaceList = interfaces[name];
    if (!interfaceList) continue;

    for (const netInterface of interfaceList) {
      if (netInterface.family === "IPv4" && !netInterface.internal && netInterface.netmask) {
        try {
          const ipParts = netInterface.address.split(".").map(Number);
          const maskParts = netInterface.netmask.split(".").map(Number);
          if (ipParts.length === 4 && maskParts.length === 4) {
            const broadcastParts = ipParts.map((part, i) => (part | (~maskParts[i] & 255)));
            broadcasts.add(broadcastParts.join("."));
          }
        } catch {
          // Fall back to 255.255.255.255
        }
      }
    }
  }

  return Array.from(broadcasts);
}
