import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthGuard } from "@/components/auth-guard";
import { AppLayout } from "@/components/layout";
import { TagDetectionProvider } from "@/context/tag-detection-context";
import NotFound from "@/pages/not-found";

import Dashboard from "@/pages/dashboard";
import Devices from "@/pages/devices";
import Vehicles from "@/pages/vehicles";
import RfidCards from "@/pages/rfid-cards";
import Logs from "@/pages/logs";
import Analytics from "@/pages/analytics";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5000,
    },
  },
});

function Router() {
  return (
    <AuthGuard>
      <AppLayout>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/devices" component={Devices} />
          <Route path="/vehicles" component={Vehicles} />
          <Route path="/rfid-cards" component={RfidCards} />
          <Route path="/logs" component={Logs} />
          <Route path="/analytics" component={Analytics} />
          <Route component={NotFound} />
        </Switch>
      </AppLayout>
    </AuthGuard>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TagDetectionProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster theme="light" position="top-right" richColors />
        </TooltipProvider>
      </TagDetectionProvider>
    </QueryClientProvider>
  );
}

export default App;
