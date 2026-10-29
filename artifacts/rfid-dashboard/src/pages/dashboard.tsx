import { useGetAnalyticsSummary, useGetDailyAnalytics, useGetVehicleUsageAnalytics, useListAccessLogs } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Car, Cpu, CreditCard, AlertTriangle, ShieldCheck, ArrowRight, ArrowLeft } from "lucide-react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, BarChart, Bar, Legend } from "recharts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGateLoggerDump } from "@/hooks/use-gate-logger";
import { useTagDetection } from "@/context/tag-detection-context";
import { Button } from "@/components/ui/button";

function StatCard({ title, value, icon: Icon, description, isLoading, className }: any) {
  return (
    <Card className={`group relative overflow-hidden hover:-translate-y-0.5 animate-rise ${className}`}>
      <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-blue-500 to-sky-400 opacity-70" />
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{title}</CardTitle>
        <div className="rounded-xl bg-gradient-to-br from-blue-50 to-sky-100 p-2 text-primary transition-transform duration-300 group-hover:scale-110">
          <Icon className="h-4 w-4" />
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-8 w-16 mb-1" />
        ) : (
          <div className="text-3xl font-mono font-bold" data-testid={`stat-${title.toLowerCase().replace(/ /g, '-')}`}>{value}</div>
        )}
        <p className="text-xs text-muted-foreground font-mono mt-1">{description}</p>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { openRegisterModal } = useTagDetection();
  const { data: summary, isLoading: isLoadingSummary } = useGetAnalyticsSummary();
  const { data: dailyAnalytics, isLoading: isLoadingDaily } = useGetDailyAnalytics({ days: 7 });
  const { data: usageAnalytics, isLoading: isLoadingUsage } = useGetVehicleUsageAnalytics({ limit: 5 });
  const { data: recentLogs, isLoading: isLoadingLogs } = useListAccessLogs({ pageSize: 10, page: 1, sortBy: "timestamp", sortOrder: "desc" });
  useGateLoggerDump();

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard 
          title="Total Vehicles" 
          value={summary?.totalVehicles ?? 0} 
          description={`${summary?.activeVehicles ?? 0} active`} 
          icon={Car} 
          isLoading={isLoadingSummary} 
        />
        <StatCard 
          title="Active Cards" 
          value={summary?.totalCards ?? 0} 
          description="Assigned to vehicles" 
          icon={CreditCard} 
          isLoading={isLoadingSummary} 
        />
        <StatCard 
          title="Online Gates" 
          value={`${summary?.onlineDevices ?? 0}/${summary?.totalDevices ?? 0}`} 
          description="Controllers active" 
          icon={Cpu} 
          isLoading={isLoadingSummary} 
        />
        <StatCard 
          title="Today's Traffic" 
          value={(summary?.entriesToday ?? 0) + (summary?.exitsToday ?? 0)} 
          description={`${summary?.entriesToday ?? 0} in / ${summary?.exitsToday ?? 0} out`} 
          icon={Activity} 
          isLoading={isLoadingSummary} 
        />
        <StatCard 
          title="Unauthorized" 
          value={summary?.unauthorizedToday ?? 0} 
          description="Attempts today" 
          icon={AlertTriangle} 
          isLoading={isLoadingSummary}
          className={summary?.unauthorizedToday && summary.unauthorizedToday > 0 ? "border-destructive/50" : ""}
        />
        <StatCard 
          title="Vehicles Inside" 
          value={summary?.vehiclesInside ?? 0} 
          description="Currently in facility" 
          icon={ShieldCheck} 
          isLoading={isLoadingSummary} 
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4 border-border ">
          <CardHeader>
            <CardTitle className="font-mono uppercase tracking-wider text-sm text-muted-foreground">7-Day Traffic Flow</CardTitle>
          </CardHeader>
          <CardContent className="pl-0">
            {isLoadingDaily ? (
              <div className="h-[300px] flex items-center justify-center">
                <Skeleton className="h-[250px] w-full mx-4" />
              </div>
            ) : (
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={dailyAnalytics ?? []} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorEntries" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--success))" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="hsl(var(--success))" stopOpacity={0}/>
                      </linearGradient>
                      <linearGradient id="colorExits" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => format(new Date(val), 'MMM d')} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                      itemStyle={{ fontFamily: 'var(--font-mono)' }}
                      labelStyle={{ color: 'hsl(var(--muted-foreground))', fontFamily: 'var(--font-mono)', marginBottom: '4px' }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }} />
                    <Area type="monotone" dataKey="entries" name="Entries" stroke="hsl(var(--success))" fillOpacity={1} fill="url(#colorEntries)" strokeWidth={2} />
                    <Area type="monotone" dataKey="exits" name="Exits" stroke="hsl(var(--primary))" fillOpacity={1} fill="url(#colorExits)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-3 border-border  flex flex-col">
          <CardHeader>
            <CardTitle className="font-mono uppercase tracking-wider text-sm text-muted-foreground">Live Activity Feed</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 p-0 overflow-hidden">
            {isLoadingLogs ? (
              <div className="space-y-4 p-6">
                {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : recentLogs?.items?.length === 0 ? (
              <div className="h-[300px] flex items-center justify-center text-muted-foreground font-mono text-sm">
                NO RECENT LOGS
              </div>
            ) : (
              <ScrollArea className="h-[300px]">
                <div className="px-6 space-y-4">
                  {recentLogs?.items.map((log) => (
                    <div key={log.id} className="flex items-start justify-between border-b border-border/50 pb-4 last:border-0 last:pb-0 animate-in fade-in slide-in-from-left-4">
                      <div className="flex items-start gap-3">
                        <div className={`mt-0.5 p-1.5 rounded-full ${
                          !log.authorized ? 'bg-destructive/20 text-destructive' :
                          log.direction === 'IN' ? 'bg-success/20 text-success' : 'bg-primary/20 text-primary'
                        }`}>
                          {!log.authorized ? <AlertTriangle className="h-4 w-4" /> : 
                           log.direction === 'IN' ? <ArrowRight className="h-4 w-4" /> : <ArrowLeft className="h-4 w-4" />}
                        </div>
                        <div>
                          <div className="font-mono text-sm font-medium flex items-center gap-2">
                            <span data-testid={`log-plate-${log.id}`}>{log.plateNumber || 'UNKNOWN VEHICLE'}</span>
                            {!log.authorized && (
                              <div className="flex items-center gap-1.5">
                                <Badge variant="destructive" className="text-[10px] px-1 py-0 h-4 rounded-sm uppercase">Denied</Badge>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-4 px-1.5 text-[9px] font-mono border-primary/40 text-primary hover:bg-primary/10"
                                  onClick={() => openRegisterModal(log.cardUid)}
                                  title={`Register tag ${log.cardUid}`}
                                >
                                  + REGISTER
                                </Button>
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground font-mono mt-0.5" data-testid={`log-device-${log.id}`}>
                            {log.ownerName ? `${log.ownerName} • ` : ''}{log.carDetails ? `${log.carDetails} • ` : ''}{log.deviceName || 'Unknown Gate'} • Card {log.cardUid.substring(0, 8)}...
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-xs" data-testid={`log-time-${log.id}`}>{format(new Date(log.timestamp), 'HH:mm:ss')}</div>
                        <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{format(new Date(log.timestamp), 'MMM dd')}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
      
      <Card className="border-border ">
        <CardHeader>
          <CardTitle className="font-mono uppercase tracking-wider text-sm text-muted-foreground">Vehicle Usage Leaderboard</CardTitle>
          <CardDescription className="font-mono text-xs">Top 5 vehicles by access frequency</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoadingUsage ? (
            <div className="space-y-4">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="font-mono text-xs">VEHICLE</TableHead>
                  <TableHead className="font-mono text-xs">OWNER</TableHead>
                  <TableHead className="font-mono text-xs text-right">TOTAL ACCESS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usageAnalytics?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center font-mono text-sm text-muted-foreground py-8">NO DATA AVAILABLE</TableCell>
                  </TableRow>
                ) : (
                  usageAnalytics?.map((usage) => (
                    <TableRow key={usage.vehicleId} className="border-border">
                      <TableCell className="font-mono font-medium">{usage.plateNumber}</TableCell>
                      <TableCell className="text-muted-foreground">{usage.ownerName}</TableCell>
                      <TableCell className="font-mono text-right">{usage.accessCount}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
