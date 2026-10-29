import { Link, useLocation } from "wouter";
import { useAuth } from "@workspace/replit-auth-web";
import { useLiveSocket } from "@/hooks/use-live-socket";
import { useFirmwareConnected } from "@/hooks/use-firmware-connected";
import {
  Activity,
  Car,
  Cpu,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Menu,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { UnregisteredTagPopup } from "@/components/unregistered-tag-popup";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  useLiveSocket();
  const firmwareConnected = useFirmwareConnected();
  const [location] = useLocation();

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <Sidebar className="border-r border-border bg-card">
          <SidebarHeader className="border-b border-border p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-sky-400 text-white shadow-lg shadow-blue-500/30">
                <Cpu className="h-5 w-5" />
              </div>
              <div className="leading-tight">
                <div className="text-base font-bold tracking-tight text-foreground">RFID Access</div>
                <div className="text-[11px] text-muted-foreground">Gate Control</div>
              </div>
            </div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarMenu className="px-2 py-4 gap-1">
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={location === "/"}
                  tooltip="Dashboard"
                >
                  <Link href="/" data-testid="link-dashboard">
                    <LayoutDashboard className="h-4 w-4" />
                    <span>Dashboard</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={location === "/logs"}
                  tooltip="Access Logs"
                >
                  <Link href="/logs" data-testid="link-logs">
                    <Activity className="h-4 w-4" />
                    <span>Access Logs</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={location === "/devices"}
                  tooltip="Gate Devices"
                >
                  <Link href="/devices" data-testid="link-devices">
                    <Cpu className="h-4 w-4" />
                    <span>Gate Devices</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={location === "/vehicles"}
                  tooltip="Vehicles"
                >
                  <Link href="/vehicles" data-testid="link-vehicles">
                    <Car className="h-4 w-4" />
                    <span>Vehicles</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={location === "/rfid-cards"}
                  tooltip="RFID Cards"
                >
                  <Link href="/rfid-cards" data-testid="link-rfid">
                    <CreditCard className="h-4 w-4" />
                    <span>RFID Cards</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
          <SidebarFooter className="border-t border-border p-4">
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground truncate max-w-[120px]">
                  {user?.email || "Operator"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={logout}
                  title="Logout"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  data-testid="button-logout"
                >
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </SidebarFooter>
        </Sidebar>

        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="h-14 border-b border-border/60 bg-white/70 flex items-center justify-between px-4 sticky top-0 z-10 backdrop-blur-md">
            <div className="flex items-center gap-4">
              <SidebarTrigger />
              <h1 className="text-sm font-semibold text-foreground/70 capitalize tracking-wide hidden sm:block">
                {location === "/" ? "System overview" : location.replace("/", "").replace("-", " ")}
              </h1>
            </div>
            <div className="flex items-center gap-3">
              {firmwareConnected && (
                <Badge variant="outline" className="border-success/50 text-success bg-success/10 font-mono gap-1.5" data-testid="status-socket">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
                  </span>
                  LIVE
                </Badge>
              )}
            </div>
          </header>
          <div className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8">
            <div key={location} className="animate-rise">
              {children}
            </div>
          </div>
          <UnregisteredTagPopup />
        </main>
      </div>
    </SidebarProvider>
  );
}
