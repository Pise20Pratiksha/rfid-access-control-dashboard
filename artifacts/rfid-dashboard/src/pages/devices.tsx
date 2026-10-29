import { useState } from "react";
import { useListEspDevices, useCreateEspDevice, useUpdateEspDevice, useDeleteEspDevice, getListEspDevicesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { format } from "date-fns";
import { Cpu, Plus, Edit2, Trash2, CheckCircle2, XCircle, Search, DoorOpen } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";

const deviceSchema = z.object({
  name: z.string().min(1, "Name is required"),
  location: z.string().min(1, "Location is required"),
  ipAddress: z.string().optional(),
});

type DeviceFormValues = z.infer<typeof deviceSchema>;

export default function Devices() {
  const queryClient = useQueryClient();
  const { data: devices, isLoading } = useListEspDevices();
  const createDevice = useCreateEspDevice();
  const updateDevice = useUpdateEspDevice();
  const deleteDevice = useDeleteEspDevice();

  const [search, setSearch] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<any>(null);

  const form = useForm<DeviceFormValues>({
    resolver: zodResolver(deviceSchema),
    defaultValues: { name: "", location: "", ipAddress: "" },
  });

  const editForm = useForm<DeviceFormValues>({
    resolver: zodResolver(deviceSchema),
  });

  const handleCreate = (data: DeviceFormValues) => {
    createDevice.mutate({ data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEspDevicesQueryKey() });
        setIsCreateOpen(false);
        form.reset();
        toast.success("Device created successfully");
      },
      onError: () => toast.error("Failed to create device")
    });
  };

  const handleUpdate = (data: DeviceFormValues) => {
    if (!editingDevice) return;
    updateDevice.mutate({ id: editingDevice.id, data }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEspDevicesQueryKey() });
        setEditingDevice(null);
        toast.success("Device updated successfully");
      },
      onError: () => toast.error("Failed to update device")
    });
  };

  const handleDelete = (id: number) => {
    deleteDevice.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListEspDevicesQueryKey() });
        toast.success("Device deleted successfully");
      },
      onError: () => toast.error("Failed to delete device")
    });
  };

  const filteredDevices = devices?.filter(d => 
    d.name.toLowerCase().includes(search.toLowerCase()) || 
    d.location.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between gap-4">
        <div className="relative max-w-sm w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search devices..." 
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 font-mono text-sm bg-card/50"
            data-testid="input-search-devices"
          />
        </div>

        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="font-mono" data-testid="button-create-device">
              <Plus className="mr-2 h-4 w-4" /> ADD GATE CONTROLLER
            </Button>
          </DialogTrigger>
          <DialogContent className="border-border bg-card">
            <DialogHeader>
              <DialogTitle className="font-mono">REGISTER NEW CONTROLLER</DialogTitle>
              <DialogDescription className="font-mono text-xs">Add an ESP32/ESP8266 device to the network.</DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(handleCreate)} className="space-y-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono text-xs">DEVICE NAME</FormLabel>
                    <FormControl><Input {...field} className="font-mono" placeholder="e.g. GATE_01" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="location" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono text-xs">LOCATION</FormLabel>
                    <FormControl><Input {...field} className="font-mono" placeholder="e.g. Main Entrance" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="ipAddress" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono text-xs">IP ADDRESS (Optional)</FormLabel>
                    <FormControl><Input {...field} className="font-mono" placeholder="192.168.1.x" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <DialogFooter>
                  <Button type="submit" disabled={createDevice.isPending} className="font-mono">
                    {createDevice.isPending ? "REGISTERING..." : "REGISTER DEVICE"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border-border bg-card/50 backdrop-blur">
        <CardHeader>
          <CardTitle className="font-mono uppercase tracking-wider text-sm text-muted-foreground flex items-center gap-2">
            <Cpu className="h-4 w-4" /> HardWare Nodes
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="font-mono text-xs">STATUS</TableHead>
                <TableHead className="font-mono text-xs">NODE NAME</TableHead>
                <TableHead className="font-mono text-xs">LOCATION</TableHead>
                <TableHead className="font-mono text-xs">IP ADDRESS</TableHead>
                <TableHead className="font-mono text-xs text-right">LAST HEARTBEAT</TableHead>
                <TableHead className="font-mono text-xs text-right">ACTIONS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(3)].map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-6 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-24 ml-auto" /></TableCell>
                    <TableCell><Skeleton className="h-8 w-16 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : filteredDevices?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center font-mono text-sm text-muted-foreground py-8">
                    NO DEVICES FOUND IN NETWORK
                  </TableCell>
                </TableRow>
              ) : (
                filteredDevices?.map(device => (
                  <TableRow key={device.id} className="border-border" data-testid={`row-device-${device.id}`}>
                    <TableCell>
                      {device.status === 'online' ? (
                        <Badge variant="outline" className="border-success/50 text-success bg-success/10 font-mono gap-1">
                          <CheckCircle2 className="h-3 w-3" /> ONLINE
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-destructive/50 text-destructive bg-destructive/10 font-mono gap-1">
                          <XCircle className="h-3 w-3" /> OFFLINE
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="font-mono font-medium">{device.name}</TableCell>
                    <TableCell className="font-mono text-muted-foreground text-xs uppercase">{device.location}</TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">{device.ipAddress || '—'}</TableCell>
                    <TableCell className="font-mono text-xs text-right text-muted-foreground">
                      {device.lastSeenAt ? format(new Date(device.lastSeenAt), 'MMM dd, HH:mm:ss') : 'NEVER'}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-primary hover:text-primary hover:bg-primary/10"
                        title="Trigger Gate Barrier Open"
                        data-testid={`button-open-gate-${device.id}`}
                        onClick={async () => {
                          try {
                            const res = await fetch(`/api/devices/${encodeURIComponent(device.name)}/command`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ cmd: "open_gate" }),
                            });
                            if (res.ok) {
                              toast.success(`Gate barrier trigger sent to ${device.name}`);
                            } else {
                              toast.error(`Device ${device.name} is currently offline or unreachable`);
                            }
                          } catch {
                            toast.error("Failed to send command to device");
                          }
                        }}
                      >
                        <DoorOpen className="h-4 w-4" />
                      </Button>

                      <Dialog open={editingDevice?.id === device.id} onOpenChange={(open) => {
                        if (open) {
                          setEditingDevice(device);
                          editForm.reset({ name: device.name, location: device.location, ipAddress: device.ipAddress || "" });
                        } else {
                          setEditingDevice(null);
                        }
                      }}>
                        <DialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" data-testid={`button-edit-${device.id}`}>
                            <Edit2 className="h-4 w-4" />
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="border-border bg-card">
                          <DialogHeader>
                            <DialogTitle className="font-mono">EDIT CONTROLLER {device.name}</DialogTitle>
                          </DialogHeader>
                          <Form {...editForm}>
                            <form onSubmit={editForm.handleSubmit(handleUpdate)} className="space-y-4">
                              <FormField control={editForm.control} name="name" render={({ field }) => (
                                <FormItem><FormLabel className="font-mono text-xs">DEVICE NAME</FormLabel><FormControl><Input {...field} className="font-mono" /></FormControl></FormItem>
                              )} />
                              <FormField control={editForm.control} name="location" render={({ field }) => (
                                <FormItem><FormLabel className="font-mono text-xs">LOCATION</FormLabel><FormControl><Input {...field} className="font-mono" /></FormControl></FormItem>
                              )} />
                              <FormField control={editForm.control} name="ipAddress" render={({ field }) => (
                                <FormItem><FormLabel className="font-mono text-xs">IP ADDRESS</FormLabel><FormControl><Input {...field} className="font-mono" /></FormControl></FormItem>
                              )} />
                              <DialogFooter>
                                <Button type="submit" disabled={updateDevice.isPending} className="font-mono">UPDATE</Button>
                              </DialogFooter>
                            </form>
                          </Form>
                        </DialogContent>
                      </Dialog>

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" data-testid={`button-delete-${device.id}`}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent className="border-border bg-card">
                          <AlertDialogHeader>
                            <AlertDialogTitle className="font-mono">DECOMMISSION NODE?</AlertDialogTitle>
                            <AlertDialogDescription className="font-mono text-sm text-muted-foreground">
                              This will permanently remove {device.name} from the network.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel className="font-mono">CANCEL</AlertDialogCancel>
                            <AlertDialogAction onClick={() => handleDelete(device.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90 font-mono">
                              DECOMMISSION
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
