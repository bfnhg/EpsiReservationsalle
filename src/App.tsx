import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { gsap } from "gsap";
import { sendBookingConfirmation, sendContactEmail } from "./email";
import { ImageGenerationLoader } from "./components/ui/image-generation-loader";

type User = { id: number; name: string; email: string; role: "student" | "admin" };
type Room = {
  id: number;
  name: string;
  building: string;
  capacity: number;
  accessible: number;
  equipment: string;
  description: string;
  favorite?: number;
};
const roomDescriptions: Record<string, string> = {
  "Salle Atlas": "Un espace lumineux pour faire avancer vos projets en équipe, partager vos idées et garder le cap grâce à son tableau blanc.",
  "Salle Horizon": "Le cadre idéal pour réunir votre équipe à distance : échangez naturellement et donnez de l’ampleur à vos réunions.",
  "Salle Pixel": "Un cocon pratique et convivial pour travailler en petit comité, se concentrer ou donner vie à vos prochaines idées.",
  "Salle Agora": "Pensée pour les grands échanges, cette salle rassemble vos équipes autour de présentations, ateliers et séances collaboratives.",
  "Salle Studio": "Un espace intimiste pour avancer au calme, préparer une présentation ou travailler à deux dans les meilleures conditions.",
};
type AdminRoom = Room & { active: number };
type BookingRules = { minDurationMinutes: number; maxDurationMinutes: number; minNoticeMinutes: number };
type AdminReservation = Reservation & { userId: number; userName: string; userEmail: string };
type AdminFavorite = { userId: number; userName: string; userEmail: string; roomId: number; roomName: string; building: string };
type SupportMessage = {
  id: number;
  userId: number;
  senderId: number;
  senderName: string;
  senderRole: "student" | "admin";
  body: string;
  createdAt: string;
  studentName?: string;
  studentEmail?: string;
};
type AdminDashboard = {
  rooms: Array<AdminRoom & { available: number }>;
  reservations: AdminReservation[];
  slotReservations: AdminReservation[];
  favorites: AdminFavorite[];
};
type Reservation = {
  id: string;
  roomId: number;
  startsAt: string;
  endsAt: string;
  status: "confirmed" | "cancelled";
  roomName: string;
  building: string;
};

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: "Une erreur est survenue." }))) as { error?: string };
    throw new ApiError(body.error ?? "Une erreur est survenue.", response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function initialBookingSlot(): { date: string; time: string } {
  const now = new Date();
  const nextHalfHour = Math.max(7 * 60, Math.ceil((now.getHours() * 60 + now.getMinutes() + 1) / 30) * 30);
  if (nextHalfHour >= 17 * 60) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return { date: dateInputValue(tomorrow), time: "09:00" };
  }
  return {
    date: dateInputValue(now),
    time: `${String(Math.floor(nextHalfHour / 60)).padStart(2, "0")}:${String(nextHalfHour % 60).padStart(2, "0")}`,
  };
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(date));
}

function formatTime(date: string): string {
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(date));
}

function formatMessageTimestamp(date: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

function dateTimeInput(date: string): { date: string; time: string } {
  const value = new Date(date);
  return {
    date: dateInputValue(value),
    time: `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`,
  };
}

function calendarEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function calendarTimestamp(value: string): string {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function googleCalendarUrl(reservation: Reservation): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `Réservation EPSI — ${reservation.roomName}`,
    dates: `${calendarTimestamp(reservation.startsAt)}/${calendarTimestamp(reservation.endsAt)}`,
    details: `Réservation de salle EPSI.\nRéférence : ${reservation.id}`,
    location: `${reservation.roomName} — ${reservation.building}`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function downloadReservationCalendar(reservation: Reservation): void {
  const now = calendarTimestamp(new Date().toISOString());
  const description = calendarEscape(`${reservation.roomName} — ${reservation.building}`);
  const calendar = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//EPSI//Reservation Salles//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${reservation.id}@epsi-reservation`,
    `DTSTAMP:${now}`,
    `DTSTART:${calendarTimestamp(reservation.startsAt)}`,
    `DTEND:${calendarTimestamp(reservation.endsAt)}`,
    `SUMMARY:${calendarEscape(`Réservation EPSI — ${reservation.roomName}`)}`,
    `LOCATION:${description}`,
    `DESCRIPTION:${calendarEscape(`Référence : ${reservation.id}`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const blob = new Blob([calendar], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `reservation-epsi-${reservation.id.slice(0, 8)}.ics`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function MenuIcon({ name }: { name: "booking" | "calendar" | "heart" | "message" | "dashboard" }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {name === "booking" && <><path d="M4 20V9l8-5 8 5v11" /><path d="M9 20v-6h6v6" /></>}
      {name === "calendar" && <><rect x="3.5" y="5" width="17" height="16" rx="2.5" /><path d="M7.5 3v4M16.5 3v4M3.5 10h17" /><path d="m9 15 2 2 4-4" /></>}
      {name === "heart" && <path d="M20.4 8.8c0 4.1-8.4 10-8.4 10s-8.4-5.9-8.4-10A4.3 4.3 0 0 1 12 6.1a4.3 4.3 0 0 1 8.4 2.7Z" />}
      {name === "message" && <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-7.5a7.5 7.5 0 1 1 17-2Z" /><path d="M8 11h8M8 14.5h5" /></>}
      {name === "dashboard" && <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="10" width="8" height="11" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /></>}
    </svg>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authError, setAuthError] = useState("");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [initialSlot] = useState(initialBookingSlot);
  const [selectedDate, setSelectedDate] = useState(initialSlot.date);
  const [startTime, setStartTime] = useState(initialSlot.time);
  const [duration, setDuration] = useState("60");
  const [minCapacity, setMinCapacity] = useState("");
  const [accessibleOnly, setAccessibleOnly] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeTab, setActiveTab] = useState<"book" | "history" | "favorites" | "admin" | "messages" | "admin-messages">("book");
  const [menuOpen, setMenuOpen] = useState(false);
  const [favorites, setFavorites] = useState<Room[]>([]);
  const [bookingRules, setBookingRules] = useState<BookingRules>({
    minDurationMinutes: 30,
    maxDurationMinutes: 240,
    minNoticeMinutes: 0,
  });
  const [adminRooms, setAdminRooms] = useState<AdminRoom[]>([]);
  const [adminDashboard, setAdminDashboard] = useState<AdminDashboard | null>(null);
  const [adminDashboardLoading, setAdminDashboardLoading] = useState(false);
  const [supportMessages, setSupportMessages] = useState<SupportMessage[]>([]);
  const [selectedSupportUserId, setSelectedSupportUserId] = useState<number | null>(null);
  const [studentMessageDraft, setStudentMessageDraft] = useState("");
  const [adminMessageDraft, setAdminMessageDraft] = useState("");
  const [sendingSupportMessage, setSendingSupportMessage] = useState(false);
  const [supportError, setSupportError] = useState("");
  const [supportNotice, setSupportNotice] = useState("");
  const [adminRules, setAdminRules] = useState<BookingRules>({
    minDurationMinutes: 30,
    maxDurationMinutes: 240,
    minNoticeMinutes: 0,
  });
  const [adminRoomId, setAdminRoomId] = useState<number | null>(null);
  const [adminRoomName, setAdminRoomName] = useState("");
  const [adminBuilding, setAdminBuilding] = useState("");
  const [adminCapacity, setAdminCapacity] = useState("8");
  const [adminAccessible, setAdminAccessible] = useState(false);
  const [adminEquipment, setAdminEquipment] = useState("");
  const [adminDescription, setAdminDescription] = useState("");
  const [adminError, setAdminError] = useState("");
  const [adminNotice, setAdminNotice] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ roomName: string; building: string; startsAt: string; endsAt: string; id: string } | null>(null);
  const [emailDelivery, setEmailDelivery] = useState<"sending" | "sent" | "failed" | null>(null);
  const [emailDeliveryMessage, setEmailDeliveryMessage] = useState("");
  const [editingReservation, setEditingReservation] = useState<Reservation | null>(null);
  const [editDate, setEditDate] = useState("");
  const [editStartTime, setEditStartTime] = useState("");
  const [editDuration, setEditDuration] = useState("60");
  const [editRoomId, setEditRoomId] = useState("");
  const [editRooms, setEditRooms] = useState<Room[]>([]);
  const [editLoadingRooms, setEditLoadingRooms] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState("");

  const start = useMemo(() => {
    if (!selectedDate || !startTime) return null;
    const value = new Date(`${selectedDate}T${startTime}`);
    return Number.isNaN(value.getTime()) ? null : value;
  }, [selectedDate, startTime]);
  const end = useMemo(() => {
    if (!start) return null;
    return new Date(start.getTime() + Number(duration) * 60_000);
  }, [start, duration]);
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const today = dateInputValue(now);
  const timeOptions = Array.from({ length: 21 }, (_, index) => 7 * 60 + index * 30).filter(
    (minutes) => selectedDate !== today || minutes > currentMinutes,
  );
  const editTimeOptions = Array.from({ length: 21 }, (_, index) => 7 * 60 + index * 30).filter(
    (minutes) => editDate !== today || minutes > currentMinutes,
  );
  const editStart = editDate && editStartTime ? new Date(`${editDate}T${editStartTime}`) : null;
  const editEnd = editStart && !Number.isNaN(editStart.getTime())
    ? new Date(editStart.getTime() + Number(editDuration) * 60_000)
    : null;
  const durationOptions = Array.from(
    { length: (bookingRules.maxDurationMinutes - bookingRules.minDurationMinutes) / 30 + 1 },
    (_, index) => bookingRules.minDurationMinutes + index * 30,
  );

  const loadReservations = useCallback(async () => {
    const data = await api<{ reservations: Reservation[] }>("/api/reservations");
    setReservations(data.reservations);
  }, []);

  const loadFavorites = useCallback(async () => {
    const data = await api<{ favorites: Room[] }>("/api/favorites");
    setFavorites(data.favorites);
  }, []);

  const loadSupportMessages = useCallback(async (isAdmin: boolean) => {
    const data = isAdmin
      ? await api<{ messages: SupportMessage[] }>("/api/admin/messages")
      : await api<{ messages: SupportMessage[] }>("/api/messages");
    setSupportMessages(data.messages);
    if (isAdmin && data.messages.length > 0) {
      setSelectedSupportUserId((current) => current ?? data.messages[0].userId);
    }
  }, []);

  const loadAdminData = useCallback(async () => {
    if (!start || !end) return;
    setAdminDashboardLoading(true);
    try {
      const [roomData, settingData, dashboardData] = await Promise.all([
        api<{ rooms: AdminRoom[] }>("/api/admin/rooms"),
        api<{ rules: BookingRules }>("/api/admin/settings"),
        api<AdminDashboard>(`/api/admin/dashboard?${new URLSearchParams({
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
        }).toString()}`),
      ]);
      setAdminRooms(roomData.rooms);
      setAdminRules(settingData.rules);
      setBookingRules(settingData.rules);
      setAdminDashboard(dashboardData);
    } finally {
      setAdminDashboardLoading(false);
    }
  }, [start, end]);

  const loadRooms = useCallback(async () => {
    if (!start || !end) return;
    setLoadingRooms(true);
    setPageError("");
    const params = new URLSearchParams({
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
    });
    if (activeTab !== "favorites" && minCapacity) params.set("capacity", minCapacity);
    if (activeTab !== "favorites" && accessibleOnly) params.set("accessible", "true");
    try {
      const data = await api<{ rooms: Room[] }>(`/api/rooms?${params.toString()}`);
      setRooms(data.rooms);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Impossible de charger les salles.");
    } finally {
      setLoadingRooms(false);
    }
  }, [start, end, minCapacity, accessibleOnly, activeTab]);

  useEffect(() => {
    if (loadingSession || user) return;
    const authScreen = document.querySelector<HTMLElement>(".auth-layout");
    if (!authScreen) return;

    const media = gsap.matchMedia();
    media.add("(max-width: 600px) and (prefers-reduced-motion: no-preference)", () => {
      const context = gsap.context(() => {
        gsap.timeline({ defaults: { ease: "power3.out" } })
          .fromTo(".auth-panel",
            { autoAlpha: 0, y: 36, rotationX: 12, transformPerspective: 900 },
            { autoAlpha: 1, y: 0, rotationX: 0, duration: 0.8 },
          )
          .fromTo(".visual-copy",
            { autoAlpha: 0, y: 18, rotationX: -8, transformPerspective: 800 },
            { autoAlpha: 1, y: 0, rotationX: 0, duration: 0.65 },
            0.12,
          )
          .fromTo(".auth-3d-object",
            { autoAlpha: 0, z: -100, rotationX: 26, rotationY: -32, scale: 0.72 },
            { autoAlpha: 1, z: 0, rotationX: 0, rotationY: 0, scale: 1, duration: 0.85, stagger: 0.12 },
            0.18,
          );

        gsap.to(".auth-3d-card", {
          y: -9,
          rotationX: -7,
          rotationY: 11,
          duration: 2.6,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
        });
        gsap.to(".auth-3d-orb", {
          y: -12,
          z: 18,
          duration: 3.2,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
        });
        gsap.to(".auth-3d-ring", {
          rotationY: 180,
          rotationZ: 28,
          duration: 7,
          ease: "none",
          repeat: -1,
          yoyo: true,
        });
      }, authScreen);

      return () => context.revert();
    });

    return () => media.revert();
  }, [loadingSession, user]);

  useEffect(() => {
    api<{ user: User }>("/api/auth/me")
      .then(({ user: currentUser }) => {
        setUser(currentUser);
        if (currentUser.role === "admin") setActiveTab("admin");
      })
      .catch((error: unknown) => {
        setUser(null);
        if (!(error instanceof ApiError) || error.status !== 401) {
          setAuthError(error instanceof Error ? error.message : "Impossible de vérifier votre session.");
        }
      })
      .finally(() => setLoadingSession(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadReservations().catch((error: unknown) => {
      setPageError(error instanceof Error ? error.message : "Impossible de charger vos réservations.");
    });
    void loadFavorites().catch((error: unknown) => {
      setPageError(error instanceof Error ? error.message : "Impossible de charger les favoris.");
    });
    api<{ rules: BookingRules }>("/api/booking-rules")
      .then(({ rules }) => {
        setBookingRules(rules);
        setDuration((current) => String(Math.min(rules.maxDurationMinutes, Math.max(rules.minDurationMinutes, Number(current)))));
      })
      .catch((error: unknown) => {
        setPageError(error instanceof Error ? error.message : "Impossible de charger les règles de réservation.");
      });
    void loadRooms();
  }, [user, loadFavorites, loadReservations, loadRooms]);

  useEffect(() => {
    if (activeTab !== "admin" || user?.role !== "admin") return;
    void loadAdminData().catch((error: unknown) => {
      setAdminError(error instanceof Error ? error.message : "Impossible de charger l’administration.");
    });
  }, [activeTab, user, loadAdminData]);

  useEffect(() => {
    if (!user || (user.role !== "admin" && activeTab !== "messages")) return;
    let loading = false;
    const refreshMessages = () => {
      if (loading || document.visibilityState !== "visible") return;
      loading = true;
      void loadSupportMessages(user.role === "admin")
        .catch((error: unknown) => {
          setSupportError(error instanceof Error ? error.message : "Impossible d’actualiser les messages.");
        })
        .finally(() => {
          loading = false;
        });
    };
    refreshMessages();
    const interval = window.setInterval(() => {
      refreshMessages();
    }, 3_000);
    document.addEventListener("visibilitychange", refreshMessages);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshMessages);
    };
  }, [activeTab, user, loadSupportMessages]);

  useEffect(() => {
    if (!editingReservation || !editStart || !editEnd || Number.isNaN(editStart.getTime())) return;
    let cancelled = false;
    setEditLoadingRooms(true);
    setEditError("");
    const params = new URLSearchParams({
      startsAt: editStart.toISOString(),
      endsAt: editEnd.toISOString(),
      excludeReservationId: editingReservation.id,
    });
    api<{ rooms: Room[] }>(`/api/rooms?${params.toString()}`)
      .then(({ rooms: availableRooms }) => {
        if (cancelled) return;
        setEditRooms(availableRooms);
        setEditRoomId((current) =>
          availableRooms.some((room) => String(room.id) === current)
            ? current
            : String(availableRooms[0]?.id ?? ""),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setEditRooms([]);
          setEditError(error instanceof Error ? error.message : "Impossible de vérifier les disponibilités.");
        }
      })
      .finally(() => {
        if (!cancelled) setEditLoadingRooms(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editingReservation, editDate, editStartTime, editDuration]);

  useEffect(() => {
    if (!confirmation && !editingReservation) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setConfirmation(null);
        setEditingReservation(null);
        setEditError("");
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [confirmation, editingReservation]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setAuthError("");
    try {
      const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body = authMode === "login" ? { email, password } : { name, email, password };
      const data = await api<{ user: User }>(endpoint, { method: "POST", body: JSON.stringify(body) });
      setUser(data.user);
      if (data.user.role === "admin") setActiveTab("admin");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "La connexion a échoué.");
    } finally {
      setBusy(false);
    }
  }

  async function bookRoom(room: Room) {
    if (!user || !start || !end) return;
    setBusy(true);
    setPageError("");
    setNotice("");
    try {
      const result = await api<{ reservationId: string }>("/api/reservations", {
        method: "POST",
        body: JSON.stringify({ roomId: room.id, startsAt: start.toISOString(), endsAt: end.toISOString() }),
      });
      setActiveTab("history");
      setConfirmation({
        roomName: room.name,
        building: room.building,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        id: result.reservationId,
      });
      setEmailDelivery("sending");
      try {
        await sendBookingConfirmation({
          name: user.name,
          email: user.email,
          roomName: room.name,
          building: room.building,
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          reservationId: result.reservationId,
        });
        setEmailDelivery("sent");
        setEmailDeliveryMessage(`Un e-mail de confirmation a été envoyé à ${user.email}.`);
      } catch (error) {
        setEmailDelivery("failed");
        setEmailDeliveryMessage(error instanceof Error
          ? `La réservation est confirmée, mais l’e-mail n’a pas pu être envoyé : ${error.message}`
          : "La réservation est confirmée, mais l’e-mail n’a pas pu être envoyé.");
      }
      await Promise.all([loadReservations(), loadRooms()]).catch((error: unknown) => {
        setPageError(error instanceof Error ? error.message : "Réservation confirmée, mais impossible d’actualiser l’affichage.");
      });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "La réservation a échoué.");
      await loadRooms();
    } finally {
      setBusy(false);
    }
  }

  function openEditReservation(reservation: Reservation) {
    const startsAt = dateTimeInput(reservation.startsAt);
    const durationMinutes = Math.round((Date.parse(reservation.endsAt) - Date.parse(reservation.startsAt)) / 60_000);
    setEditingReservation(reservation);
    setEditDate(startsAt.date);
    setEditStartTime(startsAt.time);
    setEditDuration(String(Math.min(bookingRules.maxDurationMinutes, Math.max(bookingRules.minDurationMinutes, durationMinutes))));
    setEditRoomId(String(reservation.roomId));
    setEditRooms([]);
    setEditError("");
  }

  async function saveReservationChanges(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || !editingReservation || !editStart || !editEnd || !editRoomId) return;
    setEditBusy(true);
    setEditError("");
    try {
      await api<void>(`/api/reservations/${editingReservation.id}`, {
        method: "PUT",
        body: JSON.stringify({
          roomId: Number(editRoomId),
          startsAt: editStart.toISOString(),
          endsAt: editEnd.toISOString(),
        }),
      });
      try {
        await sendBookingConfirmation({
          name: user.name,
          email: user.email,
          roomName: editRooms.find((room) => room.id === Number(editRoomId))?.name ?? editingReservation.roomName,
          building: editRooms.find((room) => room.id === Number(editRoomId))?.building ?? editingReservation.building,
          startsAt: editStart.toISOString(),
          endsAt: editEnd.toISOString(),
          reservationId: editingReservation.id,
        });
        setNotice(`Votre réservation a été modifiée. Un e-mail de confirmation mis à jour a été envoyé à ${user.email}.`);
      } catch {
        setNotice("Votre réservation a été modifiée, mais l’e-mail de confirmation mis à jour n’a pas pu être envoyé.");
      }
      setEditingReservation(null);
      await Promise.all([loadReservations(), loadRooms()]).catch((error: unknown) => {
        setPageError(error instanceof Error ? error.message : "Modification enregistrée, mais impossible d’actualiser l’affichage.");
      });
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "La modification a échoué.");
    } finally {
      setEditBusy(false);
    }
  }

  async function toggleFavorite(room: Room) {
    const isFavorite = favorites.some((favorite) => favorite.id === room.id);
    try {
      await api<void>(`/api/favorites/${room.id}`, { method: isFavorite ? "DELETE" : "PUT" });
      await loadFavorites();
      setNotice(isFavorite ? `${room.name} retirée de vos favoris.` : `${room.name} ajoutée à vos favoris.`);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Impossible de modifier vos favoris.");
    }
  }

  function startEditingRoom(room: AdminRoom) {
    setAdminRoomId(room.id);
    setAdminRoomName(room.name);
    setAdminBuilding(room.building);
    setAdminCapacity(String(room.capacity));
    setAdminAccessible(room.accessible === 1);
    setAdminEquipment(room.equipment);
    setAdminDescription(room.description || roomDescriptions[room.name] || "");
    setAdminError("");
  }

  function resetAdminRoomForm() {
    setAdminRoomId(null);
    setAdminRoomName("");
    setAdminBuilding("");
    setAdminCapacity("8");
    setAdminAccessible(false);
    setAdminEquipment("");
    setAdminDescription("");
    setAdminError("");
  }

  async function saveAdminRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAdminBusy(true);
    setAdminError("");
    setAdminNotice("");
    const currentRoom = adminRooms.find((room) => room.id === adminRoomId);
    try {
      const method = adminRoomId === null ? "POST" : "PUT";
      const endpoint = adminRoomId === null ? "/api/admin/rooms" : `/api/admin/rooms/${adminRoomId}`;
      await api(endpoint, {
        method,
        body: JSON.stringify({
          name: adminRoomName,
          building: adminBuilding,
          capacity: Number(adminCapacity),
          accessible: adminAccessible,
          equipment: adminEquipment,
          description: adminDescription,
          ...(adminRoomId !== null ? { active: currentRoom?.active === 1 } : {}),
        }),
      });
      setAdminNotice(adminRoomId === null ? "Salle ajoutée." : "Salle modifiée.");
      resetAdminRoomForm();
      await Promise.all([loadAdminData(), loadRooms()]);
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Impossible d’enregistrer cette salle.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function toggleAdminRoom(room: AdminRoom) {
    setAdminError("");
    setAdminNotice("");
    try {
      if (room.active === 1) {
        await api<void>(`/api/admin/rooms/${room.id}`, { method: "DELETE" });
      } else {
        await api<void>(`/api/admin/rooms/${room.id}`, {
          method: "PUT",
          body: JSON.stringify({
            name: room.name,
            building: room.building,
            capacity: room.capacity,
            accessible: room.accessible === 1,
            equipment: room.equipment,
            description: room.description,
            active: true,
          }),
        });
      }
      setAdminNotice(room.active === 1 ? "Salle désactivée. Elle ne sera plus proposée." : "Salle réactivée.");
      await Promise.all([loadAdminData(), loadRooms(), loadFavorites()]);
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Impossible de changer l’état de la salle.");
    }
  }

  async function saveAdminRules(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAdminBusy(true);
    setAdminError("");
    setAdminNotice("");
    try {
      await api<void>("/api/admin/settings", {
        method: "PUT",
        body: JSON.stringify(adminRules),
      });
      setBookingRules(adminRules);
      setDuration((current) => String(Math.min(adminRules.maxDurationMinutes, Math.max(adminRules.minDurationMinutes, Number(current)))));
      setAdminNotice("Règles de réservation enregistrées.");
      await loadRooms();
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Impossible d’enregistrer ces règles.");
    } finally {
      setAdminBusy(false);
    }
  }

  async function sendStudentMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || !studentMessageDraft.trim()) return;
    setSendingSupportMessage(true);
    setSupportError("");
    setSupportNotice("");
    try {
      const result = await api<{ recipient: { name: string; email: string } }>("/api/messages", {
        method: "POST",
        body: JSON.stringify({ body: studentMessageDraft }),
      });
      setStudentMessageDraft("");
      await loadSupportMessages(false);
      try {
        await sendContactEmail({
          toName: result.recipient.name,
          toEmail: result.recipient.email,
          fromName: user.name,
          fromEmail: user.email,
          message: studentMessageDraft.trim(),
        });
        setSupportNotice(`Votre message a été envoyé à l’administrateur et une notification e-mail a été transmise à ${result.recipient.email}.`);
      } catch (error) {
        setSupportNotice("Votre message est conservé dans la messagerie intégrée.");
        setSupportError(error instanceof Error
          ? `Le message est enregistré, mais la notification e-mail a échoué : ${error.message}`
          : "Le message est enregistré, mais la notification e-mail a échoué.");
      }
    } catch (error) {
      setSupportError(error instanceof Error ? error.message : "Impossible d’envoyer votre message.");
    } finally {
      setSendingSupportMessage(false);
    }
  }

  async function sendAdminReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || selectedSupportUserId === null || !adminMessageDraft.trim()) return;
    const conversation = supportMessages.filter((message) => message.userId === selectedSupportUserId);
    const recipient = conversation[0];
    if (!recipient?.studentName || !recipient.studentEmail) {
      setSupportError("Impossible de retrouver l’adresse de l’étudiant.");
      return;
    }
    setSendingSupportMessage(true);
    setSupportError("");
    setSupportNotice("");
    try {
      const result = await api<{ recipient: { name: string; email: string } }>(`/api/admin/messages/${selectedSupportUserId}`, {
        method: "POST",
        body: JSON.stringify({ body: adminMessageDraft }),
      });
      setAdminMessageDraft("");
      await loadSupportMessages(true);
      try {
        await sendContactEmail({
          toName: result.recipient.name,
          toEmail: result.recipient.email,
          fromName: user.name,
          fromEmail: user.email,
          message: adminMessageDraft.trim(),
        });
        setSupportNotice(`Réponse envoyée dans la messagerie et notification e-mail transmise à ${result.recipient.email}.`);
      } catch (error) {
        setSupportNotice("La réponse est conservée dans la messagerie intégrée.");
        setSupportError(error instanceof Error
          ? `La réponse est enregistrée, mais la notification e-mail a échoué : ${error.message}`
          : "La réponse est enregistrée, mais la notification e-mail a échoué.");
      }
    } catch (error) {
      setSupportError(error instanceof Error ? error.message : "Impossible d’envoyer la réponse.");
    } finally {
      setSendingSupportMessage(false);
    }
  }

  async function cancelReservation(reservation: Reservation) {
    setPageError("");
    setNotice("");
    try {
      await api<void>(`/api/reservations/${reservation.id}`, { method: "DELETE" });
      setNotice(`Réservation de ${reservation.roomName} annulée. Le créneau est à nouveau disponible.`);
      await Promise.all([loadReservations(), loadRooms()]);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "L’annulation a échoué.");
    }
  }

  async function logout() {
    try {
      await api<void>("/api/auth/logout", { method: "POST" });
      setUser(null);
      setReservations([]);
      setRooms([]);
      setNotice("");
      setConfirmation(null);
      setEmailDelivery(null);
      setEmailDeliveryMessage("");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "La déconnexion a échoué.");
    }
  }

  useEffect(() => {
    const hasRooms = activeTab === "favorites" ? favorites.length > 0 : rooms.length > 0;
    if (!user || (activeTab !== "book" && activeTab !== "favorites") || !hasRooms) return;
    const page = document.querySelector<HTMLElement>(".main-content");
    if (!page) return;

    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const context = gsap.context(() => {
        gsap.fromTo(".results-section > .section-heading",
          { autoAlpha: 0, y: 18 },
          { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out" },
        );
        gsap.fromTo(".room-card",
          { autoAlpha: 0, y: 34, z: -80, rotationX: 12, scale: 0.94, transformPerspective: 1000 },
          {
            autoAlpha: 1,
            y: 0,
            z: 0,
            rotationX: 0,
            scale: 1,
            duration: 0.7,
            stagger: 0.1,
            ease: "power3.out",
            clearProps: "transform",
          },
        );
        if (activeTab === "book") {
          gsap.to(".hero-orbit", {
            rotation: 360,
            duration: 24,
            ease: "none",
            repeat: -1,
          });
          gsap.to(".hero-cube", {
            y: -10,
            rotationY: 180,
            rotationX: 12,
            duration: 4,
            ease: "sine.inOut",
            repeat: -1,
            yoyo: true,
          });
          gsap.to(".hero-orb", {
            y: -14,
            z: 16,
            duration: 3,
            ease: "sine.inOut",
            repeat: -1,
            yoyo: true,
          });
        }
      }, page);
      return () => context.revert();
    });

    return () => media.revert();
  }, [activeTab, favorites, rooms, user]);

  if (loadingSession) {
    return <main className="loading-screen" aria-live="polite">Chargement de votre espace…</main>;
  }

  if (!user) {
    return (
      <main className="auth-layout">
        <section className="auth-visual">
          <div className="brand"><span className="brand-mark">E</span><span>EPSI <small>STUDENT SPACE</small></span></div>
          <div className="auth-3d-scene" aria-hidden="true">
            <span className="auth-3d-object auth-3d-orb" />
            <span className="auth-3d-object auth-3d-card" />
            <span className="auth-3d-object auth-3d-ring" />
          </div>
          <div className="visual-copy">
            <p className="eyebrow">VOTRE CAMPUS, À VOTRE RYTHME</p>
            <h1>Une salle.<br />Un créneau.<br /><em>Votre espace.</em></h1>
            <p>Réservez simplement l’espace dont vous avez besoin pour apprendre, créer et avancer.</p>
          </div>
          <div className="visual-footer"><span>01 — 05</span><span>Fait pour apprendre ensemble</span></div>
        </section>
        <section className="auth-panel">
          <div className="auth-form-wrap">
            <p className="eyebrow">RÉSERVATION DES SALLES</p>
            <h2>{authMode === "login" ? "Ravi de vous revoir." : "Bienvenue à bord."}</h2>
            <p className="muted">{authMode === "login" ? "Connectez-vous à votre espace étudiant." : "Créez votre espace étudiant en quelques secondes."}</p>
            <div className="auth-switch" role="tablist" aria-label="Type d’accès">
              <button role="tab" aria-selected={authMode === "login"} className={authMode === "login" ? "selected" : ""} onClick={() => { setAuthMode("login"); setAuthError(""); }}>Connexion</button>
              <button role="tab" aria-selected={authMode === "register"} className={authMode === "register" ? "selected" : ""} onClick={() => { setAuthMode("register"); setAuthError(""); }}>Inscription</button>
            </div>
            <form onSubmit={submitAuth} className="form-stack">
              {authMode === "register" && (
                <label>Nom complet<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required minLength={2} maxLength={80} placeholder="Alex Martin" /></label>
              )}
              <label>Adresse e-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required placeholder="vous@epsi.fr" /></label>
              <label>Mot de passe<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={authMode === "login" ? "current-password" : "new-password"} required minLength={authMode === "register" ? 8 : 1} maxLength={72} placeholder={authMode === "register" ? "8 caractères minimum" : "Votre mot de passe"} /></label>
              {authError && <p className="form-error" role="alert">{authError}</p>}
              <button className="button primary full" disabled={busy}>{busy ? "Un instant…" : authMode === "login" ? "Se connecter" : "Créer mon compte"} <span aria-hidden="true">↗</span></button>
            </form>
            <p className="privacy-note"><span aria-hidden="true">◈</span> Vos informations restent privées et sécurisées.</p>
          </div>
        </section>
      </main>
    );
  }

  const activeReservations = reservations.filter((reservation) => reservation.status === "confirmed");
  const pastReservations = reservations.filter((reservation) => reservation.status === "cancelled");
  const adminFavoriteGroups = new Map<number, { userName: string; userEmail: string; rooms: AdminFavorite[] }>();
  for (const favorite of adminDashboard?.favorites ?? []) {
    const group = adminFavoriteGroups.get(favorite.userId) ?? {
      userName: favorite.userName,
      userEmail: favorite.userEmail,
      rooms: [],
    };
    group.rooms.push(favorite);
    adminFavoriteGroups.set(favorite.userId, group);
  }
  const adminSlotReservations = adminDashboard?.slotReservations ?? [];
  const adminAvailableRooms = adminDashboard?.rooms.filter((room) => room.active === 1 && room.available === 1) ?? [];
  const adminMessageGroups = new Map<number, SupportMessage[]>();
  for (const message of supportMessages) {
    const group = adminMessageGroups.get(message.userId) ?? [];
    group.push(message);
    adminMessageGroups.set(message.userId, group);
  }
  const adminConversationRows = Array.from(adminMessageGroups, ([userId, messages]) => ({
    userId,
    studentName: messages[0].studentName ?? messages[0].senderName,
    studentEmail: messages[0].studentEmail ?? "",
    latestMessage: messages[messages.length - 1],
    messageCount: messages.length,
  })).sort((left, right) => Date.parse(right.latestMessage.createdAt) - Date.parse(left.latestMessage.createdAt));
  const selectedConversation = supportMessages.filter((message) => message.userId === selectedSupportUserId);
  const displayedRooms = activeTab === "favorites"
    ? favorites
    : rooms;
  const availableRoomIds = new Set(rooms.map((room) => room.id));

  return (
    <div className="app-shell">
      <header className="topbar">
        <a href="#" className="brand" aria-label="EPSI, accueil"><span className="brand-mark">E</span><span>EPSI <small>STUDENT SPACE</small></span></a>
        <button className="menu-toggle" type="button" aria-label={menuOpen ? "Fermer le menu" : "Ouvrir le menu"} aria-expanded={menuOpen} aria-controls="main-navigation" onClick={() => setMenuOpen((open) => !open)}>
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            {menuOpen ? <path d="m6 6 12 12M18 6 6 18" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
          </svg>
        </button>
        <nav id="main-navigation" className={menuOpen ? "main-nav is-open" : "main-nav"} aria-label="Navigation principale">
          {user.role === "admin" ? (
            <>
              <button className={activeTab === "admin" ? "nav-link active" : "nav-link"} aria-current={activeTab === "admin" ? "page" : undefined} onClick={() => { setActiveTab("admin"); setMenuOpen(false); }}><MenuIcon name="dashboard" /><span className="nav-label">Tableau de bord</span></button>
              <button className={activeTab === "admin-messages" ? "nav-link active" : "nav-link"} aria-current={activeTab === "admin-messages" ? "page" : undefined} onClick={() => { setActiveTab("admin-messages"); setMenuOpen(false); }}><MenuIcon name="message" /><span className="nav-label">Messages</span><span className="count">{adminMessageGroups.size}</span></button>
            </>
          ) : <>
            <button className={activeTab === "book" ? "nav-link active" : "nav-link"} aria-current={activeTab === "book" ? "page" : undefined} onClick={() => { setActiveTab("book"); setMenuOpen(false); }}><MenuIcon name="booking" /><span className="nav-label">Réserver</span></button>
            <button className={activeTab === "history" ? "nav-link active" : "nav-link"} aria-current={activeTab === "history" ? "page" : undefined} onClick={() => { setActiveTab("history"); setMenuOpen(false); }}><MenuIcon name="calendar" /><span className="nav-label">Mes réservations</span><span className="count">{activeReservations.length}</span></button>
            <button className={activeTab === "favorites" ? "nav-link active" : "nav-link"} aria-current={activeTab === "favorites" ? "page" : undefined} onClick={() => { setActiveTab("favorites"); setMenuOpen(false); }}><MenuIcon name="heart" /><span className="nav-label">Favoris</span><span className="count">{favorites.length}</span></button>
            <button className={activeTab === "messages" ? "nav-link active" : "nav-link"} aria-current={activeTab === "messages" ? "page" : undefined} onClick={() => { setActiveTab("messages"); setMenuOpen(false); }}><MenuIcon name="message" /><span className="nav-label">Contact</span></button>
          </>}
        </nav>
        <div className="user-menu"><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><span className="user-name">{user.name}</span><button className="logout-button" onClick={logout} aria-label="Se déconnecter" title="Se déconnecter"><svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 17l5-5-5-5M15 12H3" /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" /></svg></button></div>
      </header>

      <main className="main-content">
        <section className="welcome-row">
          <div><p className="eyebrow">{user.role === "admin" ? "ESPACE ADMINISTRATION" : "ESPACE ÉTUDIANT"} <span className="live-dot" /> EN LIGNE</p><h1>Bonjour, {user.name.split(" ")[0]}<span className="wave">.</span></h1><p className="muted">{user.role === "admin" ? (activeTab === "admin-messages" ? "Répondez aux demandes des étudiants." : "Vue d’ensemble des salles, réservations et favoris des étudiants.") : activeTab === "messages" ? "Échangez avec l’administration au sujet de vos réservations." : "Votre prochain espace de travail est à portée de main."}</p></div>
          <div className="date-badge"><span className="date-icon">◷</span><span><strong>{new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(new Date())}</strong><small>CAMPUS EPSI</small></span></div>
        </section>

        {notice && <div className="notice" role="status"><span>✓</span>{notice}<button onClick={() => setNotice("")} aria-label="Fermer">×</button></div>}
        {pageError && <div className="error-banner" role="alert"><span>!</span>{pageError}<button onClick={() => setPageError("")} aria-label="Fermer">×</button></div>}

        {activeTab === "book" || activeTab === "favorites" ? (
          <>
        {activeTab === "book" && <section className="booking-hero">
          <div className="booking-loader-stage" aria-hidden="true"><ImageGenerationLoader cellSize={5} gap={2} bandHeight={56} duration={2200} effect="shimmer" colors={["#9bd8f1", "#ffffff"]} text="EPSI" overlayOpacity={0.12} className="booking-loader-canvas" /></div>
          <div className="booking-hero-copy"><span className="hero-index">01 / RÉSERVER UN ESPACE</span><h2>Où souhaitez-vous vous installer ?</h2><p>Choisissez votre créneau, nous trouvons la salle.</p></div>
          <section className="search-panel booking-search-panel" aria-label="Critères de recherche">
            <div className="search-panel-heading"><span className="search-panel-icon" aria-hidden="true">⌕</span><div><p className="eyebrow">EPSI · VOTRE PROCHAIN ESPACE</p><h2>Personnalisez votre recherche</h2></div><span className="search-step">ÉTAPE 01 <b>—</b> 02</span></div>
            <div className="search-fields">
              <label className="search-field"><span className="field-label">DATE DE RÉSERVATION</span><span className="field-input"><span className="field-icon">▦</span><input type="date" value={selectedDate} min={dateInputValue(new Date())} onChange={(event) => setSelectedDate(event.target.value)} aria-label="Date de réservation" /></span></label>
              <label className="search-field"><span className="field-label">HEURE DE DÉBUT</span><span className="field-input"><span className="field-icon">◷</span><select value={startTime} onChange={(event) => setStartTime(event.target.value)} aria-label="Heure de début">{timeOptions.map((minutes) => { const value = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; return <option key={minutes} value={value}>{value}</option>; })}</select></span></label>
              <label className="search-field"><span className="field-label">DURÉE</span><span className="field-input"><span className="field-icon">◴</span><select value={duration} onChange={(event) => setDuration(event.target.value)} aria-label="Durée de réservation">{durationOptions.map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} minutes` : minutes % 60 === 0 ? `${minutes / 60} heure${minutes > 60 ? "s" : ""}` : `${Math.floor(minutes / 60)} h ${minutes % 60}`}</option>)}</select></span></label>
              <button className="button search-button" onClick={() => void loadRooms()} disabled={loadingRooms}><span>{loadingRooms ? "Recherche…" : "Trouver une salle"}</span><span aria-hidden="true">↗</span></button>
            </div>
            <div className="filters booking-filters"><div className="capacity-filter" role="group" aria-label="Filtrer par capacité minimum"><span className="filter-caption">CAPACITÉ MINIMUM</span><div className="capacity-chips">{[["", "Toutes"], ["4", "4+"], ["8", "8+"], ["12", "12+"], ["20", "20+"]].map(([value, label]) => <button type="button" key={value || "all"} className={minCapacity === value ? "capacity-chip selected" : "capacity-chip"} aria-pressed={minCapacity === value} onClick={() => setMinCapacity(value)}>{label}</button>)}</div></div><label className={accessibleOnly ? "check-filter selected" : "check-filter"}><input type="checkbox" checked={accessibleOnly} onChange={(event) => setAccessibleOnly(event.target.checked)} /><span aria-hidden="true">♿</span><span>Accessible PMR</span></label></div>
          </section>
        </section>}

        <section className="results-section">
          <div className="section-heading"><div><p className="eyebrow">{activeTab === "favorites" ? "VOS SALLES PRÉFÉRÉES" : "SÉLECTION EPSI · DISPONIBILITÉS EN TEMPS RÉEL"}</p><h2>{activeTab === "favorites" ? "Mes favoris" : "Trouvez votre salle"} <span className="result-count">{(activeTab === "favorites" ? favorites.length : rooms.length).toString().padStart(2, "0")}</span></h2><p className="results-subtitle">{activeTab === "favorites" ? "Vos espaces enregistrés pour les retrouver facilement." : "Choisissez l’espace idéal parmi les salles disponibles."}</p></div></div>
              {activeTab === "book" && loadingRooms && <p className="results-loading-note" role="status" aria-live="polite">Mise à jour des disponibilités…</p>}
              {displayedRooms.length === 0 ? <div className="empty-state"><span className="empty-icon">{activeTab === "favorites" ? "♡" : "⌕"}</span><h3>{activeTab === "favorites" ? "Aucune salle favorite" : "Aucune salle disponible"}</h3><p>{activeTab === "favorites" ? "Ajoutez une salle avec le cœur pour la retrouver ici." : "Essayez un autre créneau ou modifiez vos filtres."}</p></div> : (
                <div className="room-grid">{displayedRooms.map((room, index) => {
                  const available = availableRoomIds.has(room.id);
                  return <article className="room-card" key={room.id}>
                  <div className={`room-illustration room-tone-${index % 4}`}><span className="room-number">ESPACE · {String(index + 1).padStart(2, "0")}</span><span className="room-symbol" aria-hidden="true">{index % 2 ? "▱" : "⌂"}</span><button className={`favorite-button ${favorites.some((favorite) => favorite.id === room.id) ? "is-favorite" : ""}`} onClick={() => void toggleFavorite(room)} aria-label={favorites.some((favorite) => favorite.id === room.id) ? `Retirer ${room.name} des favoris` : `Ajouter ${room.name} aux favoris`} aria-pressed={favorites.some((favorite) => favorite.id === room.id)}>{favorites.some((favorite) => favorite.id === room.id) ? "♥" : "♡"}</button>{room.accessible === 1 && <span className="accessible-tag">♿ Accessible</span>}</div>
                  <div className="room-details"><div className="room-title-row"><div><h3>{room.name}</h3><p>{room.building}</p></div><span className="capacity"><span aria-hidden="true">♧</span> {room.capacity}</span></div><p className="room-description">{room.description || roomDescriptions[room.name] || `Un espace accueillant pour ${room.capacity >= 12 ? "vos réunions et projets d’équipe" : "travailler en petit groupe ou vous concentrer"}, équipé pour vous accompagner tout au long de votre session.`}</p><p className="equipment">{room.equipment.split(" · ").map((item) => <span key={item}>{item}</span>)}</p><div className="room-card-footer"><span className={available ? "availability" : "unavailable"}>{available ? <><i /> Disponible</> : "Indisponible sur ce créneau"}</span><button className="button reserve-button" onClick={() => void bookRoom(room)} disabled={busy || !available}>Réserver <span aria-hidden="true">↗</span></button></div></div>
                </article>;
                })}</div>
              )}
            </section>
          </>
        ) : activeTab === "history" ? (
          <section className="history-section"><div className="section-heading"><div><p className="eyebrow">VOTRE ESPACE PERSONNEL</p><h2>Mes réservations <span className="result-count">{activeReservations.length.toString().padStart(2, "0")}</span></h2></div><button className="button secondary" onClick={() => setActiveTab("book")}>+ Nouvelle réservation</button></div>
            {reservations.length === 0 ? <div className="empty-state"><span className="empty-icon">▦</span><h3>Rien de prévu pour le moment</h3><p>Votre prochaine session commence par la réservation d’une salle.</p><button className="button primary" onClick={() => setActiveTab("book")}>Trouver une salle <span>↗</span></button></div> : <div className="reservation-list">{[...activeReservations, ...pastReservations].map((reservation) => <article className={`reservation-item ${reservation.status === "cancelled" ? "cancelled" : ""}`} key={reservation.id}><div className="reservation-date"><strong>{new Intl.DateTimeFormat("fr-FR", { day: "2-digit" }).format(new Date(reservation.startsAt))}</strong><span>{new Intl.DateTimeFormat("fr-FR", { month: "short" }).format(new Date(reservation.startsAt)).toUpperCase()}</span></div><div className="reservation-info"><h3>{reservation.roomName}</h3><p>{reservation.building}</p><span>{formatDate(reservation.startsAt)} · {formatTime(reservation.startsAt)} – {formatTime(reservation.endsAt)}</span></div><div className="reservation-actions"><span className={reservation.status === "confirmed" ? "status-pill confirmed" : "status-pill"}>{reservation.status === "confirmed" ? "Confirmée" : "Annulée"}</span>{reservation.status === "confirmed" && <><a className="cancel-button calendar-link" href={googleCalendarUrl(reservation)} target="_blank" rel="noopener noreferrer">Google Calendar</a><button className="cancel-button" onClick={() => downloadReservationCalendar(reservation)}>Exporter .ics</button><button className="cancel-button" onClick={() => openEditReservation(reservation)}>Modifier</button><button className="cancel-button" onClick={() => void cancelReservation(reservation)}>Annuler</button></>}</div></article>)}</div>}
          </section>
        ) : activeTab === "admin" ? (
          <section className="admin-section">
            <div className="section-heading"><div><p className="eyebrow">VUE D’ENSEMBLE DU CAMPUS</p><h2>Tableau de bord admin</h2></div><button className="button secondary" onClick={() => void loadAdminData()} disabled={adminDashboardLoading}>{adminDashboardLoading ? "Actualisation…" : "Actualiser"}</button></div>
            {adminNotice && <div className="notice" role="status"><span>✓</span>{adminNotice}<button onClick={() => setAdminNotice("")} aria-label="Fermer">×</button></div>}
            {adminError && <div className="error-banner" role="alert"><span>!</span>{adminError}<button onClick={() => setAdminError("")} aria-label="Fermer">×</button></div>}
            <section className="admin-panel admin-availability-filter" aria-label="Choisir un créneau pour voir les disponibilités">
              <div className="admin-panel-heading"><div><p className="eyebrow">DISPONIBILITÉS</p><h3>État des salles pour un créneau</h3></div></div>
              <div className="admin-filter-fields">
                <label>Date<input type="date" value={selectedDate} min={today} onChange={(event) => setSelectedDate(event.target.value)} /></label>
                <label>Heure de début<select value={startTime} onChange={(event) => setStartTime(event.target.value)}>{Array.from({ length: 21 }, (_, index) => 7 * 60 + index * 30).map((minutes) => { const value = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; return <option key={minutes} value={value}>{value}</option>; })}</select></label>
                <label>Durée<select value={duration} onChange={(event) => setDuration(event.target.value)}>{durationOptions.map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} minutes` : minutes % 60 === 0 ? `${minutes / 60} heure${minutes > 60 ? "s" : ""}` : `${Math.floor(minutes / 60)} h ${minutes % 60}`}</option>)}</select></label>
              </div>
              <p className="muted admin-filter-hint">Les disponibilités sont recalculées automatiquement pour le créneau sélectionné.</p>
            </section>
            {adminDashboardLoading && !adminDashboard ? <div className="empty-state">Chargement des données du campus…</div> : <>
              <div className="admin-stat-grid">
                <article className="admin-stat"><span>Salles actives</span><strong>{adminDashboard?.rooms.filter((room) => room.active === 1).length ?? 0}</strong></article>
                <article className="admin-stat"><span>Salles disponibles</span><strong>{adminAvailableRooms.length}</strong></article>
                <article className="admin-stat"><span>Salles réservées sur ce créneau</span><strong>{adminSlotReservations.length}</strong></article>
                <article className="admin-stat"><span>Étudiants avec favoris</span><strong>{adminFavoriteGroups.size}</strong></article>
              </div>
              <div className="admin-overview-grid">
                <section className="admin-panel">
                  <div className="admin-panel-heading"><div><p className="eyebrow">LIBRES SUR LE CRÉNEAU</p><h3>Salles disponibles ({adminAvailableRooms.length})</h3></div></div>
                  {adminAvailableRooms.length === 0 ? <p className="admin-empty-note">Aucune salle n’est disponible pour ce créneau.</p> : <div className="admin-room-list">{adminAvailableRooms.map((room) => <article className="admin-room-row" key={room.id}>
                    <div className="admin-room-info"><strong>{room.name}</strong><span>{room.building} · {room.capacity} places{room.accessible === 1 ? " · PMR" : ""}</span><small>{room.equipment || "Aucun équipement indiqué"}</small></div>
                    <span className="status-pill confirmed">Disponible</span>
                  </article>)}</div>}
                </section>
                <section className="admin-panel">
                  <div className="admin-panel-heading"><div><p className="eyebrow">SALLE ET ÉTUDIANT</p><h3>Salles réservées sur ce créneau ({adminSlotReservations.length})</h3></div></div>
                  {adminSlotReservations.length === 0 ? <p className="admin-empty-note">Aucune salle n’est réservée sur ce créneau.</p> : <div className="admin-room-list">{adminSlotReservations.map((reservation) => <article className="admin-room-row admin-booking-row" key={reservation.id}>
                    <div className="admin-room-info"><strong>{reservation.roomName}</strong><span>{formatDate(reservation.startsAt)} · {formatTime(reservation.startsAt)}–{formatTime(reservation.endsAt)}</span><small>Réservé par {reservation.userName} · {reservation.userEmail}</small></div>
                    <span className="status-pill confirmed">Confirmée</span>
                  </article>)}</div>}
                </section>
              </div>
              <section className="admin-panel admin-history-panel">
                <div className="admin-panel-heading"><div><p className="eyebrow">TOUTES LES RÉSERVATIONS</p><h3>Historique ({adminDashboard?.reservations.length ?? 0})</h3></div></div>
                {(adminDashboard?.reservations.length ?? 0) === 0 ? <p className="admin-empty-note">Aucune réservation dans l’historique.</p> : <div className="admin-room-list">{adminDashboard?.reservations.map((reservation) => <article className="admin-room-row admin-booking-row" key={reservation.id}>
                  <div className="admin-room-info"><strong>{reservation.roomName} · {reservation.userName}</strong><span>{formatDate(reservation.startsAt)} · {formatTime(reservation.startsAt)}–{formatTime(reservation.endsAt)}</span><small>{reservation.userEmail} · Réf. {reservation.id}</small></div>
                  <span className={reservation.status === "confirmed" ? "status-pill confirmed" : "status-pill"}>{reservation.status === "confirmed" ? "Confirmée" : "Annulée"}</span>
                </article>)}</div>}
              </section>
              <section className="admin-panel admin-history-panel">
                <div className="admin-panel-heading"><div><p className="eyebrow">PRÉFÉRENCES DES ÉTUDIANTS</p><h3>Salles favorites par élève ({adminFavoriteGroups.size})</h3></div></div>
                {adminFavoriteGroups.size === 0 ? <p className="admin-empty-note">Aucun favori enregistré.</p> : <div className="admin-favorite-grid">{Array.from(adminFavoriteGroups, ([userId, student]) => <article className="admin-favorite-card" key={userId}>
                  <div><strong>{student.userName}</strong><span>{student.userEmail}</span></div>
                  <ul>{student.rooms.map((favorite) => <li key={favorite.roomId}>{favorite.roomName}<small>{favorite.building}</small></li>)}</ul>
                </article>)}</div>}
              </section>
            </>}
            <div className="admin-grid">
              <section className="admin-panel">
                <div className="admin-panel-heading"><div><p className="eyebrow">PARC DE SALLES</p><h3>{adminRoomId === null ? "Ajouter une salle" : "Modifier une salle"}</h3></div></div>
                <form className="form-stack admin-form" onSubmit={(event) => void saveAdminRoom(event)}>
                  <label>Nom de la salle<input value={adminRoomName} onChange={(event) => setAdminRoomName(event.target.value)} minLength={2} maxLength={80} required placeholder="Salle Neptune" /></label>
                  <label>Bâtiment et étage<input value={adminBuilding} onChange={(event) => setAdminBuilding(event.target.value)} minLength={2} maxLength={120} required placeholder="Bâtiment A · 1er étage" /></label>
                  <label>Capacité<input type="number" min="1" max="1000" value={adminCapacity} onChange={(event) => setAdminCapacity(event.target.value)} required /></label>
                  <label>Équipements<input value={adminEquipment} onChange={(event) => setAdminEquipment(event.target.value)} maxLength={300} placeholder="Écran · Tableau blanc" /></label>
                  <label>Description<textarea value={adminDescription} onChange={(event) => setAdminDescription(event.target.value)} minLength={10} maxLength={500} required placeholder="Présentez l’ambiance et les usages de cette salle…" rows={3} /></label>
                  <label className="admin-checkbox"><input type="checkbox" checked={adminAccessible} onChange={(event) => setAdminAccessible(event.target.checked)} /> Accessible PMR</label>
                  <div className="modal-actions"><button type="button" className="button secondary" onClick={resetAdminRoomForm}>Effacer</button><button className="button primary" disabled={adminBusy}>{adminBusy ? "Enregistrement…" : adminRoomId === null ? "Ajouter" : "Enregistrer"}</button></div>
                </form>
              </section>

              <section className="admin-panel">
                <div className="admin-panel-heading"><div><p className="eyebrow">RÈGLES GLOBALES</p><h3>Conditions de réservation</h3></div></div>
                <form className="form-stack admin-form" onSubmit={(event) => void saveAdminRules(event)}>
                  <label>Durée minimum<select value={adminRules.minDurationMinutes} onChange={(event) => setAdminRules({ ...adminRules, minDurationMinutes: Number(event.target.value) })}>{[30,60,90,120,150,180,210,240].map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} minutes` : `${minutes / 60} h${minutes % 60 ? ` ${minutes % 60}` : ""}`}</option>)}</select></label>
                  <label>Durée maximum<select value={adminRules.maxDurationMinutes} onChange={(event) => setAdminRules({ ...adminRules, maxDurationMinutes: Number(event.target.value) })}>{[30,60,90,120,150,180,210,240].map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} minutes` : `${minutes / 60} h${minutes % 60 ? ` ${minutes % 60}` : ""}`}</option>)}</select></label>
                  <label>Délai minimum avant le créneau<select value={adminRules.minNoticeMinutes} onChange={(event) => setAdminRules({ ...adminRules, minNoticeMinutes: Number(event.target.value) })}>{[0,30,60,120,240,360,720,1440,2880].map((minutes) => <option key={minutes} value={minutes}>{minutes === 0 ? "Aucun délai" : minutes < 60 ? `${minutes} minutes` : minutes % 1440 === 0 ? `${minutes / 1440} jour${minutes > 1440 ? "s" : ""}` : minutes % 60 === 0 ? `${minutes / 60} heure${minutes > 60 ? "s" : ""}` : `${Math.floor(minutes / 60)} h ${minutes % 60}`}</option>)}</select></label>
                  {adminRules.minDurationMinutes > adminRules.maxDurationMinutes && <p className="form-error" role="alert">La durée minimum doit être inférieure ou égale à la durée maximum.</p>}
                  <div className="modal-actions"><button className="button primary" disabled={adminBusy || adminRules.minDurationMinutes > adminRules.maxDurationMinutes}>{adminBusy ? "Enregistrement…" : "Enregistrer les règles"}</button></div>
                </form>
              </section>
            </div>
            <section className="admin-panel room-management">
              <div className="admin-panel-heading"><div><p className="eyebrow">SALLES CONFIGURÉES</p><h3>Toutes les salles ({adminRooms.length})</h3></div></div>
              <div className="admin-room-list">{adminRooms.map((room) => <article className={`admin-room-row ${room.active === 0 ? "inactive-room" : ""}`} key={room.id}>
                <div className="admin-room-info"><strong>{room.name}</strong><span>{room.building} · {room.capacity} places{room.accessible === 1 ? " · PMR" : ""}</span><small>{room.description || roomDescriptions[room.name] || "Description non renseignée"}{room.equipment ? ` · ${room.equipment}` : ""}</small></div>
                <span className={room.active === 1 ? "status-pill confirmed" : "status-pill"}>{room.active === 1 ? "Active" : "Désactivée"}</span>
                <div className="admin-room-actions"><button className="cancel-button" onClick={() => startEditingRoom(room)}>Modifier</button><button className="cancel-button" onClick={() => void toggleAdminRoom(room)}>{room.active === 1 ? "Désactiver" : "Réactiver"}</button></div>
              </article>)}</div>
            </section>
          </section>
        ) : activeTab === "messages" ? (
          <section className="support-section">
            <div className="section-heading support-page-heading"><div><p className="eyebrow">AIDE ET ASSISTANCE</p><h2>On est là pour vous aider<span className="wave">.</span></h2><p className="support-hero-copy">Une question sur votre réservation ? Écrivez-nous, l’équipe EPSI vous répondra ici.</p></div><div className="support-hero-art" aria-hidden="true"><span className="support-art-orbit" /><span className="support-art-sphere" /><span className="support-art-card support-art-card-back">EPSI · SUPPORT</span><span className="support-art-card support-art-card-front">✉ <i>Votre équipe est à l’écoute</i></span></div></div>
            {supportNotice && <div className="notice" role="status"><span>✓</span>{supportNotice}<button onClick={() => setSupportNotice("")} aria-label="Fermer">×</button></div>}
            {supportError && <div className="error-banner" role="alert"><span>!</span>{supportError}<button onClick={() => setSupportError("")} aria-label="Fermer">×</button></div>}
            <section className="support-panel student-support-panel">
              <div className="support-panel-heading"><div><p className="eyebrow">VOTRE CONVERSATION</p><h3>Messages avec l’équipe EPSI</h3></div><span className="support-channel"><i /> Espace de discussion</span></div>
              <div className="support-thread" aria-live="polite">
                {supportMessages.length === 0 ? <p className="support-empty">Décrivez votre problème de réservation ; l’équipe d’administration vous répondra ici.</p> : supportMessages.map((message, index) => <article className={`support-message ${message.senderRole === user.role ? "support-message-mine" : ""}`} key={message.id} style={{ "--message-index": index } as React.CSSProperties}>
                  <span className={`support-message-avatar ${message.senderRole === "admin" ? "support-avatar-admin" : ""}`} aria-hidden="true">{message.senderRole === "admin" ? "E" : message.senderName.trim().charAt(0).toUpperCase()}</span>
                  <div className="support-message-bubble"><div className="support-message-meta"><strong>{message.senderRole === "admin" ? "Équipe EPSI" : message.senderName}</strong><time dateTime={message.createdAt}>{formatMessageTimestamp(message.createdAt)}</time></div>
                    <p>{message.body}</p>
                  </div>
                </article>)}
              </div>
              <form className="support-compose" onSubmit={(event) => void sendStudentMessage(event)}>
                <label htmlFor="student-support-message">Votre message</label>
                <textarea id="student-support-message" value={studentMessageDraft} onChange={(event) => setStudentMessageDraft(event.target.value)} minLength={1} maxLength={2000} required placeholder="Expliquez-nous le problème rencontré avec votre réservation…" />
                <div className="support-compose-footer"><span>{studentMessageDraft.length}/2000 · Une notification sera envoyée par e-mail.</span><button className="button primary" disabled={sendingSupportMessage || !studentMessageDraft.trim()}>{sendingSupportMessage ? "Envoi…" : "Envoyer le message"}</button></div>
              </form>
            </section>
          </section>
        ) : (
          <section className="support-section">
            <div className="section-heading"><div><p className="eyebrow">ASSISTANCE ÉTUDIANTE</p><h2>Messagerie des étudiants</h2></div><button className="button secondary" onClick={() => void loadSupportMessages(true)} disabled={sendingSupportMessage}>Actualiser</button></div>
            {supportNotice && <div className="notice" role="status"><span>✓</span>{supportNotice}<button onClick={() => setSupportNotice("")} aria-label="Fermer">×</button></div>}
            {supportError && <div className="error-banner" role="alert"><span>!</span>{supportError}<button onClick={() => setSupportError("")} aria-label="Fermer">×</button></div>}
            <section className="support-inbox">
              <section className="support-conversations" aria-label="Liste des conversations étudiantes">
                <div className="support-panel-heading"><div><p className="eyebrow">BOÎTE DE RÉCEPTION · ACTUALISATION AUTOMATIQUE</p><h3>Conversations ({adminConversationRows.length})</h3></div><button className="cancel-button" onClick={() => void loadSupportMessages(true)} disabled={sendingSupportMessage}>Actualiser</button></div>
                {adminConversationRows.length === 0 ? <p className="support-empty">Aucun message reçu pour le moment.</p> : <div className="support-table-wrap">
                  <table className="support-table">
                    <thead><tr><th>Étudiant</th><th>Dernier message</th><th>Reçu le</th><th>Messages</th><th>Action</th></tr></thead>
                    <tbody>{adminConversationRows.map((conversation) => <tr className={selectedSupportUserId === conversation.userId ? "selected" : ""} key={conversation.userId}>
                      <td><strong>{conversation.studentName}</strong><span>{conversation.studentEmail}</span></td>
                      <td className="support-table-preview">{conversation.latestMessage.body}</td>
                      <td><time dateTime={conversation.latestMessage.createdAt}>{formatMessageTimestamp(conversation.latestMessage.createdAt)}</time></td>
                      <td>{conversation.messageCount}</td>
                      <td><button className="support-open-button" onClick={() => setSelectedSupportUserId(conversation.userId)}>{selectedSupportUserId === conversation.userId ? "Ouverte" : "Lire / répondre"}</button></td>
                    </tr>)}</tbody>
                  </table>
                </div>}
              </section>
              <section className="support-chat" aria-label="Conversation sélectionnée">
                {selectedConversation.length === 0 ? <div className="support-empty support-chat-empty">Sélectionnez une conversation pour lire et répondre.</div> : <>
                  <div className="support-panel-heading"><div><p className="eyebrow">ÉTUDIANT</p><h3>{selectedConversation[0].studentName}</h3><span className="support-student-email">{selectedConversation[0].studentEmail}</span></div></div>
                  <div className="support-thread" aria-live="polite">{selectedConversation.map((message, index) => <article className={`support-message ${message.senderRole === "admin" ? "support-message-mine" : ""}`} key={message.id} style={{ "--message-index": index } as React.CSSProperties}>
                    <span className={`support-message-avatar ${message.senderRole === "admin" ? "support-avatar-admin" : ""}`} aria-hidden="true">{message.senderRole === "admin" ? "E" : message.senderName.trim().charAt(0).toUpperCase()}</span>
                    <div className="support-message-bubble"><div className="support-message-meta"><strong>{message.senderRole === "admin" ? "Équipe EPSI" : message.senderName}</strong><time dateTime={message.createdAt}>{formatMessageTimestamp(message.createdAt)}</time></div>
                      <p>{message.body}</p>
                    </div>
                  </article>)}</div>
                  <form className="support-compose" onSubmit={(event) => void sendAdminReply(event)}>
                    <label htmlFor="admin-support-reply">Votre réponse</label>
                    <textarea id="admin-support-reply" value={adminMessageDraft} onChange={(event) => setAdminMessageDraft(event.target.value)} minLength={1} maxLength={2000} required placeholder="Rédigez votre réponse à l’étudiant…" />
                    <div className="support-compose-footer"><span>{adminMessageDraft.length}/2000 · Une notification sera envoyée par e-mail.</span><button className="button primary" disabled={sendingSupportMessage || !adminMessageDraft.trim()}>{sendingSupportMessage ? "Envoi…" : "Répondre"}</button></div>
                  </form>
                </>}
              </section>
            </section>
          </section>
        )}
        <footer className="page-footer"><span>EPSI <b>·</b> RÉSERVATION DES SALLES</span><span>Étudiez, créez, partagez.</span></footer>
      </main>
      {confirmation && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmation(null); }}>
        <section className="modal-card confirmation-modal" role="dialog" aria-modal="true" aria-labelledby="confirmation-title">
          <button className="modal-close" onClick={() => setConfirmation(null)} aria-label="Fermer">×</button>
          <div className="confirmation-check" aria-hidden="true">✓</div>
          <p className="eyebrow">C’EST RÉSERVÉ</p>
          <h2 id="confirmation-title">Votre espace vous attend.</h2>
          <p className="muted">La réservation a bien été enregistrée.</p>
          <div className="confirmation-details">
            <strong>{confirmation.roomName}</strong>
            <span>{confirmation.building}</span>
            <span>{formatDate(confirmation.startsAt)}</span>
            <span>{formatTime(confirmation.startsAt)} – {formatTime(confirmation.endsAt)}</span>
            <small>RÉFÉRENCE · {confirmation.id}</small>
          </div>
          <p className={`email-delivery ${emailDelivery ?? "sending"}`} role="status" aria-live="polite">
            {emailDelivery === "sending" && "Envoi de l’e-mail de confirmation…"}
            {emailDelivery === "sent" && emailDeliveryMessage}
            {emailDelivery === "failed" && emailDeliveryMessage}
            {!emailDelivery && "Préparation de la confirmation par e-mail…"}
          </p>
          <button className="button primary full" onClick={() => setConfirmation(null)}>Compris <span aria-hidden="true">↗</span></button>
        </section>
      </div>}
      {editingReservation && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !editBusy) setEditingReservation(null); }}>
        <section className="modal-card edit-modal" role="dialog" aria-modal="true" aria-labelledby="edit-title">
          <button className="modal-close" onClick={() => setEditingReservation(null)} aria-label="Fermer" disabled={editBusy}>×</button>
          <p className="eyebrow">MODIFIER LA RÉSERVATION</p>
          <h2 id="edit-title">Changez votre créneau.</h2>
          <p className="muted">Choisissez une salle et une nouvelle disponibilité.</p>
          <form className="form-stack edit-form" onSubmit={(event) => void saveReservationChanges(event)}>
            <label>Date<input type="date" value={editDate} min={today} onChange={(event) => setEditDate(event.target.value)} required /></label>
            <div className="edit-form-row">
              <label>Heure de début<select value={editStartTime} onChange={(event) => setEditStartTime(event.target.value)} required>{editTimeOptions.map((minutes) => { const value = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; return <option key={minutes} value={value}>{value}</option>; })}</select></label>
              <label>Durée<select value={editDuration} onChange={(event) => setEditDuration(event.target.value)}>{durationOptions.map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} minutes` : minutes % 60 === 0 ? `${minutes / 60} heure${minutes > 60 ? "s" : ""}` : `${Math.floor(minutes / 60)} h ${minutes % 60}`}</option>)}</select></label>
            </div>
            <label>Salle<select value={editRoomId} onChange={(event) => setEditRoomId(event.target.value)} disabled={editLoadingRooms || editRooms.length === 0} required><option value="">{editLoadingRooms ? "Vérification des disponibilités…" : "Choisir une salle"}</option>{editRooms.map((room) => <option key={room.id} value={room.id}>{room.name} · {room.building}</option>)}</select></label>
            {editError && <p className="form-error" role="alert">{editError}</p>}
            {!editLoadingRooms && editRooms.length === 0 && !editError && <p className="form-error" role="status">Aucune salle disponible sur ce créneau.</p>}
            <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setEditingReservation(null)} disabled={editBusy}>Annuler</button><button className="button primary" disabled={editBusy || editLoadingRooms || !editRoomId}>{editBusy ? "Enregistrement…" : "Enregistrer"}</button></div>
          </form>
        </section>
      </div>}
    </div>
  );
}

export default App;
