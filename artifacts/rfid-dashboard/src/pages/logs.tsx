import { useState } from "react";
import { useListAccessLogs } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Activity, Search, AlertTriangle, ArrowRight, ArrowLeft, Download, Filter } from "lucide-react";
import { useTagDetection } from "@/context/tag-detection-context";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function Logs() {
  const { openRegisterModal } = useTagDetection();
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState<string>("ALL");
  const [authFilter, setAuthFilter] = useState<string>("ALL");
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const { data: logPage, isLoading } = useListAccessLogs({
    search: search || undefined,
    direction: direction !== "ALL" ? (direction as "IN" | "OUT") : undefined,
    authorized: authFilter !== "ALL" ? authFilter === "AUTH" : undefined,
    page,
    pageSize,
    sortBy: "timestamp",
    sortOrder: "desc"
  });

  const handleExport = (format: 'csv' | 'excel' | 'pdf') => {
    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (direction !== "ALL") params.append('direction', direction);
    if (authFilter !== "ALL") params.append('authorized', (authFilter === "AUTH").toString());
    
    window.location.href = `/api/access-logs/export/${format}?${params.toString()}`;
  };

  return (
    <div className="space-y-4 flex flex-col h-[calc(100vh-8rem)]">
      <div className="flex flex-wrap gap-4 justify-between items-center bg-card/50 p-4 border border-border rounded-lg backdrop-blur">
        <div className="flex flex-wrap gap-4 items-center">
          <div className="relative w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input 
              placeholder="Search plate or UID..." 
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              className="pl-9 font-mono text-sm h-9 bg-background/50"
            />
          </div>
          
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select value={direction} onValueChange={(v) => { setDirection(v); setPage(1); }}>
              <SelectTrigger className="w-28 font-mono text-xs h-9 bg-background/50">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">ALL DIR</SelectItem>
                <SelectItem value="IN">INBOUND</SelectItem>
                <SelectItem value="OUT">OUTBOUND</SelectItem>
              </SelectContent>
            </Select>

            <Select value={authFilter} onValueChange={(v) => { setAuthFilter(v); setPage(1); }}>
              <SelectTrigger className="w-32 font-mono text-xs h-9 bg-background/50">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">ALL STATUS</SelectItem>
                <SelectItem value="AUTH">AUTHORIZED</SelectItem>
                <SelectItem value="DENIED">DENIED</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="font-mono text-xs h-9 border-primary/20 hover:bg-primary/10" onClick={() => handleExport('csv')}>
            <Download className="h-3 w-3 mr-2" /> CSV
          </Button>
          <Button variant="outline" size="sm" className="font-mono text-xs h-9 border-primary/20 hover:bg-primary/10" onClick={() => handleExport('excel')}>
            <Download className="h-3 w-3 mr-2" /> XLSX
          </Button>
          <Button variant="outline" size="sm" className="font-mono text-xs h-9 border-primary/20 hover:bg-primary/10" onClick={() => handleExport('pdf')}>
            <Download className="h-3 w-3 mr-2" /> PDF
          </Button>
        </div>
      </div>

      <Card className="border-border bg-card/50 backdrop-blur flex-1 flex flex-col min-h-0">
        <CardHeader className="py-3 border-b border-border/50 bg-card/50">
          <CardTitle className="font-mono uppercase tracking-wider text-sm text-muted-foreground flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4" /> Live Access Stream
            </div>
            <div className="text-xs">
              {logPage?.total ? `RECORD ${((page-1)*pageSize)+1}-${Math.min(page*pageSize, logPage.total)} OF ${logPage.total}` : '...'}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 flex-1 overflow-auto">
          <Table className="relative">
            <TableHeader className="sticky top-0 bg-card z-10 shadow-sm border-b border-border">
              <TableRow className="hover:bg-transparent">
                <TableHead className="font-mono text-[10px] w-[140px]">TIMESTAMP</TableHead>
                <TableHead className="font-mono text-[10px] w-[100px]">DIRECTION</TableHead>
                <TableHead className="font-mono text-[10px]">VEHICLE / OWNER</TableHead>
                <TableHead className="font-mono text-[10px]">TAG UID</TableHead>
                <TableHead className="font-mono text-[10px]">NODE</TableHead>
                <TableHead className="font-mono text-[10px] text-right">STATUS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(15)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-full" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : logPage?.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center font-mono text-sm text-muted-foreground py-12">
                    NO LOGS FOUND MATCHING FILTERS
                  </TableCell>
                </TableRow>
              ) : (
                logPage?.items.map(log => (
                  <TableRow key={log.id} className="border-border hover:bg-accent/60 border-b border-border/40 font-mono text-sm">
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {format(new Date(log.timestamp), 'yyyy-MM-dd HH:mm:ss')}
                    </TableCell>
                    <TableCell>
                      {log.direction === 'IN' ? (
                        <div className="flex items-center text-success text-xs"><ArrowRight className="h-3 w-3 mr-1" /> IN</div>
                      ) : (
                        <div className="flex items-center text-primary text-xs"><ArrowLeft className="h-3 w-3 mr-1" /> OUT</div>
                      )}
                    </TableCell>
                    <TableCell>
                      {log.plateNumber ? (
                        <div>
                          <span className="font-bold text-foreground mr-2">{log.plateNumber}</span>
                          <span className="text-foreground text-xs">{log.ownerName}</span>
                          {log.carDetails && (
                            <div className="text-muted-foreground text-[11px]">{log.carDetails}</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs italic">UNKNOWN VEHICLE</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground tracking-widest text-xs">{log.cardUid}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{log.deviceName || `ID:${log.deviceId}`}</TableCell>
                    <TableCell className="text-right">
                      {log.authorized ? (
                        <Badge variant="outline" className="border-success/30 text-success bg-success/10 font-mono text-[10px]">AUTHORIZED</Badge>
                      ) : (
                        <div className="flex items-center justify-end gap-1.5">
                          <Badge variant="outline" className="border-destructive text-destructive bg-destructive/10 font-mono text-[10px]">DENIED</Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px] font-mono border-primary/40 text-primary hover:bg-primary/10"
                            onClick={() => openRegisterModal(log.cardUid)}
                            title={`Register tag ${log.cardUid}`}
                          >
                            + REGISTER
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
        <div className="p-3 border-t border-border/50 bg-card/50 flex justify-between items-center shrink-0">
          <Button 
            variant="outline" 
            size="sm" 
            className="font-mono text-xs" 
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
          >
            PREV PAGE
          </Button>
          <div className="font-mono text-xs text-muted-foreground">PAGE {page}</div>
          <Button 
            variant="outline" 
            size="sm" 
            className="font-mono text-xs" 
            disabled={!logPage || logPage.items.length < pageSize}
            onClick={() => setPage(p => p + 1)}
          >
            NEXT PAGE
          </Button>
        </div>
      </Card>
    </div>
  );
}
