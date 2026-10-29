import React, { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateRfidCard,
  useListVehicles,
  useCreateVehicle,
  getListRfidCardsQueryKey,
  getListVehiclesQueryKey,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  Radio,
  CreditCard,
  Plus,
  Check,
  Copy,
  X,
  Volume2,
  VolumeX,
  Car,
  ChevronLeft,
  ChevronRight,
  ShieldCheck,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  Cpu,
  Tag,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTagDetection, DetectedTagEvent } from "@/context/tag-detection-context";

const registerCardSchema = z.object({
  cardUid: z.string().min(1, "UID is required"),
  vehicleId: z.coerce.number().nullable().optional(),
  active: z.boolean().default(true),
  // Optional inline quick-add vehicle fields
  isNewVehicle: z.boolean().default(true),
  plateNumber: z.string().optional(),
  ownerName: z.string().optional(),
  carDetails: z.string().optional(),
  vehicleType: z.enum(["car", "bike", "truck", "bus", "other"]).default("car"),
}).refine(
  (data) => {
    if (data.isNewVehicle) {
      return Boolean(data.plateNumber && data.plateNumber.trim() && data.ownerName && data.ownerName.trim());
    }
    return true;
  },
  {
    message: "Name and vehicle number are required to register this tag",
    path: ["plateNumber"],
  }
);

type RegisterCardFormValues = z.infer<typeof registerCardSchema>;

export function UnregisteredTagPopup() {
  const {
    unregisteredTags,
    activeTagForRegistration,
    isRegisterModalOpen,
    soundEnabled,
    setSoundEnabled,
    openRegisterModal,
    closeRegisterModal,
    dismissUnregisteredTag,
    dismissAllUnregisteredTags,
  } = useTagDetection();

  const [currentIndex, setCurrentIndex] = useState(0);
  const [copiedUid, setCopiedUid] = useState<string | null>(null);

  // Keep currentIndex in bounds when items change
  useEffect(() => {
    if (currentIndex >= unregisteredTags.length && unregisteredTags.length > 0) {
      setCurrentIndex(unregisteredTags.length - 1);
    }
  }, [unregisteredTags.length, currentIndex]);

  const currentTag = unregisteredTags[currentIndex] ?? unregisteredTags[0];

  const handleCopy = (uid: string) => {
    navigator.clipboard.writeText(uid);
    setCopiedUid(uid);
    toast.success("Card UID copied to clipboard");
    setTimeout(() => setCopiedUid(null), 2000);
  };

  return (
    <>
      {/* Floating Unregistered Tag Alert Notification */}
      {unregisteredTags.length > 0 && currentTag && (
        <div
          className="fixed bottom-6 right-6 z-50 max-w-md w-full animate-in fade-in slide-in-from-bottom-5 duration-300 pointer-events-auto"
          role="alert"
          aria-live="assertive"
        >
          <div className="relative overflow-hidden rounded-xl border border-primary/40 bg-card p-5 shadow-2xl backdrop-blur-xl ring-1 ring-primary/20">
            {/* Glowing accent border line */}
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-sky-400 to-blue-500 animate-pulse" />

            {/* Header */}
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-border/60">
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-3.5 w-3.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-primary"></span>
                </span>
                <span className="font-mono text-xs font-bold uppercase tracking-wider text-primary flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 text-primary" />
                  UNREGISTERED TAG DETECTED
                </span>
              </div>

              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground"
                  onClick={() => setSoundEnabled(!soundEnabled)}
                  title={soundEnabled ? "Mute audio alerts" : "Enable audio alerts"}
                >
                  {soundEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5 text-muted-foreground/60" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => dismissUnregisteredTag(currentTag.cardUid)}
                  title="Dismiss alert"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Tag Details Card Body */}
            <div className="mt-3 space-y-3">
              <div className="flex items-center justify-between rounded-lg bg-background/80 border border-border/80 px-3 py-2.5">
                <div className="space-y-0.5">
                  <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                    Scanned UID
                  </span>
                  <div className="font-mono text-base font-bold tracking-widest text-primary flex items-center gap-2">
                    <Tag className="h-4 w-4 text-primary" />
                    <span>{currentTag.cardUid}</span>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-2.5 text-xs font-mono border-border hover:bg-accent"
                  onClick={() => handleCopy(currentTag.cardUid)}
                  title="Copy UID"
                >
                  {copiedUid === currentTag.cardUid ? (
                    <Check className="h-3.5 w-3.5 text-success" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div className="flex items-center gap-1.5 rounded-md bg-muted/40 p-2 text-muted-foreground">
                  <Cpu className="h-3.5 w-3.5 text-primary" />
                  <span className="truncate">{currentTag.deviceName || "Main Gate ESP32"}</span>
                </div>
                <div className="flex items-center justify-between rounded-md bg-muted/40 p-2">
                  <span className="text-muted-foreground">Direction:</span>
                  <Badge
                    variant="outline"
                    className={`font-mono text-[10px] px-1.5 py-0 ${
                      currentTag.direction === "IN"
                        ? "border-success/50 text-success bg-success/10"
                        : "border-primary/50 text-primary bg-primary/10"
                    }`}
                  >
                    {currentTag.direction === "IN" ? (
                      <ArrowRight className="h-3 w-3 mr-0.5" />
                    ) : (
                      <ArrowLeft className="h-3 w-3 mr-0.5" />
                    )}
                    {currentTag.direction}
                  </Badge>
                </div>
              </div>

              <div className="text-[11px] text-muted-foreground font-mono">
                This RFID tag is not in the authorized database. Access was automatically denied.
              </div>
            </div>

            {/* Actions */}
            <div className="mt-4 flex items-center justify-between gap-2 pt-2 border-t border-border/40">
              {unregisteredTags.length > 1 ? (
                <div className="flex items-center gap-1 text-xs font-mono text-muted-foreground">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={currentIndex === 0}
                    onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <span>
                    {currentIndex + 1}/{unregisteredTags.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={currentIndex === unregisteredTags.length - 1}
                    onClick={() => setCurrentIndex((i) => Math.min(unregisteredTags.length - 1, i + 1))}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs font-mono text-muted-foreground hover:text-foreground h-8 px-2"
                  onClick={() => dismissUnregisteredTag(currentTag.cardUid)}
                >
                  Dismiss
                </Button>
              )}

              <div className="flex items-center gap-2">
                {unregisteredTags.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs font-mono text-muted-foreground hover:text-destructive h-8 px-2"
                    onClick={dismissAllUnregisteredTags}
                  >
                    Dismiss All
                  </Button>
                )}
                <Button
                  size="sm"
                  className="font-mono text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 shadow-md"
                  onClick={() => openRegisterModal(currentTag)}
                  data-testid="button-register-unregistered-tag"
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> REGISTER TAG
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Register Tag Modal */}
      <RegisterTagDialog
        isOpen={isRegisterModalOpen}
        onClose={closeRegisterModal}
        initialTag={activeTagForRegistration}
      />
    </>
  );
}

interface RegisterTagDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialTag: DetectedTagEvent | null;
}

export function RegisterTagDialog({ isOpen, onClose, initialTag }: RegisterTagDialogProps) {
  const queryClient = useQueryClient();
  const { data: vehicles, isLoading: isLoadingVehicles } = useListVehicles({});
  const createCard = useCreateRfidCard();
  const createVehicle = useCreateVehicle();
  const { dismissUnregisteredTag } = useTagDetection();

  const [isNewVehicleMode, setIsNewVehicleMode] = useState(true);

  const form = useForm<RegisterCardFormValues>({
    resolver: zodResolver(registerCardSchema),
    defaultValues: {
      cardUid: initialTag?.cardUid || "",
      vehicleId: null,
      active: true,
      isNewVehicle: true,
      plateNumber: "",
      ownerName: "",
      carDetails: "",
      vehicleType: "car",
    },
  });

  // Reset form with new initial tag whenever modal opens
  useEffect(() => {
    if (isOpen && initialTag) {
      form.reset({
        cardUid: initialTag.cardUid,
        vehicleId: null,
        active: true,
        isNewVehicle: true,
        plateNumber: "",
        ownerName: "",
        carDetails: "",
        vehicleType: "car",
      });
      setIsNewVehicleMode(true);
    }
  }, [isOpen, initialTag, form]);

  const handleSubmit = async (values: RegisterCardFormValues) => {
    try {
      let finalVehicleId = values.vehicleId;

      // 1. If operator wants to create a new vehicle right in this form
      if (values.isNewVehicle && values.plateNumber && values.ownerName) {
        const newVeh = await createVehicle.mutateAsync({
          data: {
            plateNumber: values.plateNumber.toUpperCase().trim(),
            ownerName: values.ownerName.trim(),
            carDetails: values.carDetails?.trim() || undefined,
            vehicleType: values.vehicleType,
            status: "active",
          },
        });
        finalVehicleId = newVeh.id;
        queryClient.invalidateQueries({ queryKey: getListVehiclesQueryKey() });
      }

      // 2. Provision the RFID card
      await createCard.mutateAsync({
        data: {
          cardUid: values.cardUid.toUpperCase().trim(),
          vehicleId: finalVehicleId ?? null,
          active: values.active,
        },
      });

      // 3. Invalidate queries & dismiss from queue
      queryClient.invalidateQueries({ queryKey: getListRfidCardsQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["/api/access-logs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/analytics/summary"] });

      dismissUnregisteredTag(values.cardUid);
      toast.success("Tag registered", {
        description: `Entry/exit logs for this tag will now appear under ${values.ownerName?.trim() || "the selected vehicle"}.`,
      });

      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to register card";
      toast.error("Registration failed", { description: msg });
    }
  };

  const isSubmitting = createCard.isPending || createVehicle.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md border-border bg-card">
        <DialogHeader>
          <DialogTitle className="font-mono flex items-center gap-2 text-base">
            <CreditCard className="h-5 w-5 text-primary" />
            REGISTER RFID TAG
          </DialogTitle>
        </DialogHeader>

        {initialTag?.deviceName && (
          <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs font-mono text-muted-foreground border border-border/50">
            <Radio className="h-3.5 w-3.5 text-primary animate-pulse" />
            <span>
              Detected at <strong className="text-foreground">{initialTag.deviceName}</strong> ({initialTag.direction})
            </span>
          </div>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            {/* UID Field */}
            <FormField
              control={form.control}
              name="cardUid"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-mono text-xs">TAG UID (HEX)</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      className="font-mono uppercase tracking-widest font-bold text-primary"
                      placeholder="e.g. E2801170000002"
                      data-testid="input-register-card-uid"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Vehicle Selection or Quick Add */}
            {!isNewVehicleMode ? (
              <FormField
                control={form.control}
                name="vehicleId"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center justify-between">
                      <FormLabel className="font-mono text-xs">ASSIGN TO VEHICLE</FormLabel>
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0 text-xs font-mono text-primary flex items-center gap-1"
                        onClick={() => {
                          setIsNewVehicleMode(true);
                          form.setValue("isNewVehicle", true);
                          form.setValue("vehicleId", null);
                        }}
                      >
                        <Plus className="h-3 w-3" /> Register new owner
                      </Button>
                    </div>
                    <Select
                      onValueChange={(val) => field.onChange(val === "unassigned" ? null : parseInt(val))}
                      value={field.value?.toString() || "unassigned"}
                    >
                      <FormControl>
                        <SelectTrigger className="font-mono">
                          <SelectValue placeholder="Select vehicle" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="unassigned" className="text-muted-foreground italic font-mono">
                          UNASSIGNED (GENERAL ACCESS)
                        </SelectItem>
                        {vehicles?.map((v) => (
                          <SelectItem key={v.id} value={v.id.toString()} className="font-mono">
                            {v.plateNumber} — {v.ownerName} ({v.vehicleType})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              /* Quick Add Vehicle Inline Form */
              <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3.5 animate-in fade-in">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold text-primary flex items-center gap-1.5">
                    <Car className="h-3.5 w-3.5" /> OWNER & VEHICLE DETAILS
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px] font-mono text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setIsNewVehicleMode(false);
                      form.setValue("isNewVehicle", false);
                    }}
                  >
                    Use existing vehicle
                  </Button>
                </div>

                <FormField
                  control={form.control}
                  name="ownerName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono text-[11px]">NAME</FormLabel>
                      <FormControl>
                        <Input {...field} className="font-mono text-xs" placeholder="John Doe" data-testid="input-register-owner-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="plateNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono text-[11px]">VEHICLE NO.</FormLabel>
                      <FormControl>
                        <Input {...field} className="font-mono uppercase text-xs" placeholder="MH12AB1234" data-testid="input-register-plate" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="vehicleType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono text-[11px]">VEHICLE TYPE</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger className="font-mono text-xs">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="font-mono text-xs">
                          <SelectItem value="car">CAR</SelectItem>
                          <SelectItem value="truck">TRUCK</SelectItem>
                          <SelectItem value="bike">BIKE</SelectItem>
                          <SelectItem value="bus">BUS</SelectItem>
                          <SelectItem value="other">OTHER</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="carDetails"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono text-[11px]">CAR DETAILS</FormLabel>
                      <FormControl>
                        <Input {...field} className="font-mono text-xs" placeholder="e.g. White Honda City 2021" data-testid="input-register-car-details" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            {/* Active Switch */}
            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border border-border p-3">
                  <div className="space-y-0.5">
                    <FormLabel className="font-mono text-xs flex items-center gap-1.5">
                      <ShieldCheck className="h-3.5 w-3.5 text-success" />
                      ACTIVE & AUTHORIZED
                    </FormLabel>
                    <p className="text-[11px] text-muted-foreground font-mono">
                      Allow gate barrier to open when this tag is detected
                    </p>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting} className="font-mono">
                CANCEL
              </Button>
              <Button
                type="submit"
                disabled={isSubmitting}
                className="font-mono bg-primary hover:bg-primary/90 text-primary-foreground"
                data-testid="button-submit-register-tag"
              >
                {isSubmitting ? "SAVING..." : "REGISTER & AUTHORIZE"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
