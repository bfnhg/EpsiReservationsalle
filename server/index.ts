import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import helmet from "helmet";
import { z } from "zod";
import { database, lockRoom, transaction, type QueryConnection } from "./db.js";

const app = express();
const port = Number(process.env.PORT ?? 3001);
const jwtSecret = process.env.JWT_SECRET ?? "";
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET est obligatoire et doit contenir au moins 32 caractères.");
}

declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "connect-src": ["'self'", "https://api.emailjs.com"],
    },
  },
}));
app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Trop de tentatives. Réessayez dans quelques minutes." },
});
const supportRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Trop de messages envoyés. Réessayez plus tard." },
});

const cookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const registrationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email().max(254),
  password: z.string().min(8).max(72),
});
const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(72),
});

function issueToken(userId: number): string {
  return jwt.sign({ sub: String(userId) }, jwtSecret, { expiresIn: "7d" });
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.session;
  if (typeof token !== "string") {
    res.status(401).json({ error: "Connectez-vous pour continuer." });
    return;
  }
  try {
    const payload = jwt.verify(token, jwtSecret);
    if (typeof payload === "string" || typeof payload.sub !== "string" || !/^\d+$/.test(payload.sub)) {
      res.status(401).json({ error: "Session invalide. Veuillez vous reconnecter." });
      return;
    }
    req.userId = Number(payload.sub);
    next();
  } catch {
    res.status(401).json({ error: "Session expirée. Veuillez vous reconnecter." });
  }
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, async () => {
    if (req.userId === undefined) {
      res.status(401).json({ error: "Connectez-vous pour continuer." });
      return;
    }
    try {
      const user = await database.one<{ role: string }>("SELECT role FROM users WHERE id = ?", req.userId);
      if (user?.role !== "admin") {
        res.status(403).json({ error: "Accès réservé à l’administration." });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  });
}

type ReservationRules = {
  minDurationMinutes: number;
  maxDurationMinutes: number;
  minNoticeMinutes: number;
};

async function getReservationRules(connection: QueryConnection = database): Promise<ReservationRules> {
  const settings = await connection.many<{ key: string; value: string }>("SELECT key, value FROM app_settings");
  const values = new Map(settings.map((setting) => [setting.key, Number(setting.value)]));
  return {
    minDurationMinutes: values.get("min_duration_minutes") ?? 30,
    maxDurationMinutes: values.get("max_duration_minutes") ?? 240,
    minNoticeMinutes: values.get("min_notice_minutes") ?? 0,
  };
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | undefined {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Données invalides." });
    return undefined;
  }
  return parsed.data;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && (
    "code" in error && error.code === "23505" ||
    error.message.includes("UNIQUE constraint failed")
  );
}

app.post("/api/auth/register", authRateLimit, async (req, res) => {
  const input = parseBody(registrationSchema, req.body, res);
  if (!input) return;
  const email = input.email.trim().toLowerCase();
  const existingUser = await database.one("SELECT id FROM users WHERE email = ?", email);
  if (existingUser) {
    res.status(409).json({ error: "Cette adresse e-mail est déjà utilisée." });
    return;
  }

  const passwordHash = bcrypt.hashSync(input.password, 12);
  try {
    const user = await database.one<{ id: number }>(
      "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?) RETURNING id",
      input.name,
      email,
      passwordHash,
    );
    if (!user) throw new Error("La création du compte n’a retourné aucun identifiant.");
    res.cookie("session", issueToken(Number(user.id)), cookieOptions);
    res.status(201).json({ user: { id: Number(user.id), name: input.name, email, role: "student" } });
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Cette adresse e-mail est déjà utilisée." });
      return;
    }
    throw error;
  }
});

app.post("/api/auth/login", authRateLimit, async (req, res) => {
  const input = parseBody(loginSchema, req.body, res);
  if (!input) return;
  const user = await database.one<{ id: number; name: string; email: string; password_hash: string; role: string }>(
    "SELECT id, name, email, password_hash, role FROM users WHERE email = ?",
    input.email.trim().toLowerCase(),
  );
  if (!user || !bcrypt.compareSync(input.password, user.password_hash)) {
    res.status(401).json({ error: "Adresse e-mail ou mot de passe incorrect." });
    return;
  }
  res.cookie("session", issueToken(user.id), cookieOptions);
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("session", { ...cookieOptions, maxAge: undefined });
  res.status(204).end();
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (userId === undefined) {
    res.status(401).json({ error: "Connectez-vous pour continuer." });
    return;
  }
  const user = await database.one("SELECT id, name, email, role FROM users WHERE id = ?", userId);
  if (!user) {
    res.clearCookie("session", { ...cookieOptions, maxAge: undefined });
    res.status(401).json({ error: "Compte introuvable." });
    return;
  }
  res.json({ user });
});

const roomsQuerySchema = z.object({
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  capacity: z.coerce.number().int().min(1).max(1000).optional(),
  accessible: z.enum(["true", "false"]).optional(),
  excludeReservationId: z.uuid().optional(),
});

app.get("/api/booking-rules", requireAuth, async (_req, res) => {
  res.json({ rules: await getReservationRules() });
});

app.get("/api/rooms", requireAuth, async (req, res) => {
  const parsed = roomsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Sélectionnez une date et un créneau valides." });
    return;
  }
  const { startsAt, endsAt, capacity, accessible, excludeReservationId } = parsed.data;
  const userId = req.userId;
  if (userId === undefined) {
    res.status(401).json({ error: "Connectez-vous pour continuer." });
    return;
  }
  if (excludeReservationId) {
    const ownedReservation = await database.one(`
      SELECT id FROM reservations
      WHERE id = ? AND user_id = ? AND status = 'confirmed'
    `, excludeReservationId, userId);
    if (!ownedReservation) {
      res.status(404).json({ error: "Réservation active introuvable." });
      return;
    }
  }
  const startsAtUtc = new Date(startsAt).toISOString();
  const endsAtUtc = new Date(endsAt).toISOString();
  if (Date.parse(startsAtUtc) >= Date.parse(endsAtUtc)) {
    res.status(400).json({ error: "L’heure de fin doit être après l’heure de début." });
    return;
  }
  if (Date.parse(startsAtUtc) < Date.now()) {
    res.status(400).json({ error: "Le créneau doit commencer dans le futur." });
    return;
  }
  const rules = await getReservationRules();
  const durationMinutes = (Date.parse(endsAtUtc) - Date.parse(startsAtUtc)) / 60_000;
  if (
    durationMinutes % 30 !== 0 ||
    durationMinutes < rules.minDurationMinutes ||
    durationMinutes > rules.maxDurationMinutes ||
    Date.parse(startsAtUtc) - Date.now() < rules.minNoticeMinutes * 60_000
  ) {
    res.status(400).json({ error: "Ce créneau ne respecte pas les règles actuelles de réservation." });
    return;
  }

  const filteredRooms = await database.many(`
      SELECT r.id, r.name, r.building, r.capacity, r.accessible, r.equipment,
        EXISTS(SELECT 1 FROM room_favorites f WHERE f.room_id = r.id AND f.user_id = ?) AS favorite
      FROM rooms r
      WHERE r.active = 1
        AND (? = 0 OR r.capacity >= ?)
        AND (? = 0 OR r.accessible = 1)
        AND NOT EXISTS (
          SELECT 1 FROM reservations b
          WHERE b.room_id = r.id
            AND b.status = 'confirmed'
            AND (? = '' OR b.id != ?)
            AND b.starts_at < ?
            AND b.ends_at > ?
        )
      ORDER BY r.capacity, r.name
    `,
    userId,
    capacity ?? 0,
    capacity ?? 0,
    accessible === "true" ? 1 : 0,
    excludeReservationId ?? "",
    excludeReservationId ?? "",
    endsAtUtc,
    startsAtUtc,
  );
  res.json({ rooms: filteredRooms });
});

const reservationSchema = z.object({
  roomId: z.number().int().positive(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
});
const updateReservationSchema = reservationSchema;

app.post("/api/reservations", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (userId === undefined) {
    res.status(401).json({ error: "Connectez-vous pour continuer." });
    return;
  }
  const ownerId = userId;
  const input = parseBody(reservationSchema, req.body, res);
  if (!input) return;
  const start = Date.parse(input.startsAt);
  const end = Date.parse(input.endsAt);
  const durationMinutes = (end - start) / 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || durationMinutes <= 0 || durationMinutes % 30 !== 0) {
    res.status(400).json({ error: "La durée doit être un multiple de 30 minutes." });
    return;
  }
  if (start < Date.now()) {
    res.status(400).json({ error: "La réservation doit commencer dans le futur." });
    return;
  }
  const startsAtUtc = new Date(start).toISOString();
  const endsAtUtc = new Date(end).toISOString();

  const createReservation = await transaction(async (connection) => {
    await lockRoom(connection, input.roomId);
    const room = await connection.one("SELECT id FROM rooms WHERE id = ? AND active = 1", input.roomId);
    if (!room) return { kind: "error" as const, error: "Cette salle n’existe pas.", status: 404 };
    const rules = await getReservationRules(connection);
    if (
      durationMinutes % 30 !== 0 ||
      durationMinutes < rules.minDurationMinutes ||
      durationMinutes > rules.maxDurationMinutes ||
      start - Date.now() < rules.minNoticeMinutes * 60_000
    ) {
      return { kind: "error" as const, error: "Ce créneau ne respecte pas les règles actuelles de réservation.", status: 400 };
    }

    const conflict = await connection.one(`
        SELECT id FROM reservations
        WHERE room_id = ?
          AND status = 'confirmed'
          AND starts_at < ?
          AND ends_at > ?
        LIMIT 1
      `, input.roomId, endsAtUtc, startsAtUtc);
    if (conflict) return { kind: "error" as const, error: "Cette salle vient d’être réservée sur ce créneau. Choisissez-en un autre.", status: 409 };

    const id = crypto.randomUUID();
    await connection.run(`
      INSERT INTO reservations (id, user_id, room_id, starts_at, ends_at)
      VALUES (?, ?, ?, ?, ?)
    `, id, ownerId, input.roomId, startsAtUtc, endsAtUtc);
    return { kind: "success" as const, id };
  });

  if (createReservation.kind === "error") {
    res.status(createReservation.status).json({ error: createReservation.error });
    return;
  }
  res.status(201).json({ reservationId: createReservation.id });
});

app.put("/api/reservations/:id", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (userId === undefined) {
    res.status(401).json({ error: "Connectez-vous pour continuer." });
    return;
  }
  const reservationId = z.uuid().safeParse(req.params.id);
  if (!reservationId.success) {
    res.status(400).json({ error: "Identifiant de réservation invalide." });
    return;
  }
  const input = parseBody(updateReservationSchema, req.body, res);
  if (!input) return;
  const start = Date.parse(input.startsAt);
  const end = Date.parse(input.endsAt);
  const durationMinutes = (end - start) / 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || durationMinutes <= 0 || durationMinutes % 30 !== 0) {
    res.status(400).json({ error: "La durée doit être un multiple de 30 minutes." });
    return;
  }
  if (start < Date.now()) {
    res.status(400).json({ error: "La réservation doit commencer dans le futur." });
    return;
  }
  const startsAtUtc = new Date(start).toISOString();
  const endsAtUtc = new Date(end).toISOString();
  const updateReservation = await transaction(async (connection) => {
    await lockRoom(connection, input.roomId);
    const reservation = await connection.one(`
      SELECT id FROM reservations
      WHERE id = ? AND user_id = ? AND status = 'confirmed'
    `, reservationId.data, userId);
    if (!reservation) {
      return { kind: "error" as const, status: 404, error: "Réservation active introuvable." };
    }

    const room = await connection.one("SELECT id FROM rooms WHERE id = ? AND active = 1", input.roomId);
    if (!room) {
      return { kind: "error" as const, status: 404, error: "Cette salle n’existe pas." };
    }

    const conflict = await connection.one(`
      SELECT id FROM reservations
      WHERE room_id = ?
        AND id != ?
        AND status = 'confirmed'
        AND starts_at < ?
        AND ends_at > ?
      LIMIT 1
    `, input.roomId, reservationId.data, endsAtUtc, startsAtUtc);
    if (conflict) {
      return { kind: "error" as const, status: 409, error: "Cette salle vient d’être réservée sur ce créneau. Choisissez-en un autre." };
    }

    const rules = await getReservationRules(connection);
    if (
      durationMinutes % 30 !== 0 ||
      durationMinutes < rules.minDurationMinutes ||
      durationMinutes > rules.maxDurationMinutes ||
      start - Date.now() < rules.minNoticeMinutes * 60_000
    ) {
      return { kind: "error" as const, status: 400, error: "Ce créneau ne respecte pas les règles actuelles de réservation." };
    }

    await connection.run(`
      UPDATE reservations
      SET room_id = ?, starts_at = ?, ends_at = ?
      WHERE id = ? AND user_id = ? AND status = 'confirmed'
    `, input.roomId, startsAtUtc, endsAtUtc, reservationId.data, userId);
    return { kind: "success" as const };
  });

  if (updateReservation.kind === "error") {
    res.status(updateReservation.status).json({ error: updateReservation.error });
    return;
  }
  res.status(204).end();
});

app.get("/api/reservations", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (userId === undefined) {
    res.status(401).json({ error: "Connectez-vous pour continuer." });
    return;
  }
  const reservations = await database.many(`
      SELECT b.id, b.starts_at AS startsAt, b.ends_at AS endsAt, b.status,
        b.room_id AS roomId, r.name AS roomName, r.building
      FROM reservations b
      JOIN rooms r ON r.id = b.room_id
      WHERE b.user_id = ?
      ORDER BY b.starts_at DESC
    `, userId);
  res.json({ reservations });
});

app.delete("/api/reservations/:id", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (userId === undefined) {
    res.status(401).json({ error: "Connectez-vous pour continuer." });
    return;
  }
  const reservationId = z.uuid().safeParse(req.params.id);
  if (!reservationId.success) {
    res.status(400).json({ error: "Identifiant de réservation invalide." });
    return;
  }
  const result = await database.run(`
      UPDATE reservations SET status = 'cancelled'
      WHERE id = ? AND user_id = ? AND status = 'confirmed'
    `, reservationId.data, userId);
  if (result.changes === 0) {
    res.status(404).json({ error: "Réservation active introuvable." });
    return;
  }
  res.status(204).end();
});

app.get("/api/favorites", requireAuth, async (req, res) => {
  if (req.userId === undefined) {
    res.status(401).json({ error: "Connectez-vous pour continuer." });
    return;
  }
  const favorites = await database.many(`
    SELECT r.id, r.name, r.building, r.capacity, r.accessible, r.equipment
    FROM room_favorites f
    JOIN rooms r ON r.id = f.room_id
    WHERE f.user_id = ? AND r.active = 1
    ORDER BY r.name
  `, req.userId);
  res.json({ favorites });
});

app.put("/api/favorites/:roomId", requireAuth, async (req, res) => {
  if (req.userId === undefined) {
    res.status(401).json({ error: "Connectez-vous pour continuer." });
    return;
  }
  const roomId = z.coerce.number().int().positive().safeParse(req.params.roomId);
  if (!roomId.success) {
    res.status(400).json({ error: "Identifiant de salle invalide." });
    return;
  }
  const room = await database.one("SELECT id FROM rooms WHERE id = ? AND active = 1", roomId.data);
  if (!room) {
    res.status(404).json({ error: "Salle introuvable." });
    return;
  }
  await database.run("INSERT INTO room_favorites (user_id, room_id) VALUES (?, ?) ON CONFLICT DO NOTHING", req.userId, roomId.data);
  res.status(204).end();
});

app.delete("/api/favorites/:roomId", requireAuth, async (req, res) => {
  if (req.userId === undefined) {
    res.status(401).json({ error: "Connectez-vous pour continuer." });
    return;
  }
  const roomId = z.coerce.number().int().positive().safeParse(req.params.roomId);
  if (!roomId.success) {
    res.status(400).json({ error: "Identifiant de salle invalide." });
    return;
  }
  await database.run("DELETE FROM room_favorites WHERE user_id = ? AND room_id = ?", req.userId, roomId.data);
  res.status(204).end();
});

const supportMessageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

app.get("/api/messages", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (userId === undefined) {
    res.status(401).json({ error: "Connectez-vous pour continuer." });
    return;
  }
  const student = await database.one<{ role: string }>("SELECT role FROM users WHERE id = ?", userId);
  if (student?.role !== "student") {
    res.status(403).json({ error: "La messagerie étudiante est réservée aux comptes étudiants." });
    return;
  }
  const messages = await database.many(`
    SELECT m.id, m.user_id AS userId, m.sender_id AS senderId,
      u.name AS senderName, u.role AS senderRole, m.body, m.created_at AS createdAt
    FROM support_messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.user_id = ?
    ORDER BY m.created_at, m.id
  `, userId);
  res.json({ messages });
});

app.post("/api/messages", supportRateLimit, requireAuth, async (req, res) => {
  const userId = req.userId;
  if (userId === undefined) {
    res.status(401).json({ error: "Connectez-vous pour continuer." });
    return;
  }
  const student = await database.one<{ role: string }>("SELECT role FROM users WHERE id = ?", userId);
  if (student?.role !== "student") {
    res.status(403).json({ error: "La messagerie étudiante est réservée aux comptes étudiants." });
    return;
  }
  const input = parseBody(supportMessageSchema, req.body, res);
  if (!input) return;
  const admin = await database.one<{ id: number; name: string; email: string }>(`
    SELECT id, name, email FROM users
    WHERE role = 'admin'
    ORDER BY id
    LIMIT 1
  `);
  if (!admin) {
    res.status(503).json({ error: "Aucun administrateur n’est disponible pour le moment." });
    return;
  }
  const result = await database.one<{ id: number }>(`
    INSERT INTO support_messages (user_id, sender_id, body)
    VALUES (?, ?, ?)
    RETURNING id
  `, userId, userId, input.body);
  if (!result) throw new Error("L’enregistrement du message n’a pas retourné son identifiant.");
  const message = await database.one(`
    SELECT m.id, m.user_id AS userId, m.sender_id AS senderId,
      u.name AS senderName, u.role AS senderRole, m.body, m.created_at AS createdAt
    FROM support_messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `, result.id);
  res.status(201).json({ message, recipient: { name: admin.name, email: admin.email } });
});

app.get("/api/admin/messages", requireAdmin, async (_req, res) => {
  const messages = await database.many(`
    SELECT m.id, m.user_id AS userId, m.sender_id AS senderId,
      student.name AS studentName, student.email AS studentEmail,
      sender.name AS senderName, sender.role AS senderRole,
      m.body, m.created_at AS createdAt
    FROM support_messages m
    JOIN users student ON student.id = m.user_id
    JOIN users sender ON sender.id = m.sender_id
    WHERE student.role = 'student'
    ORDER BY m.created_at, m.id
  `);
  res.json({ messages });
});

app.post("/api/admin/messages/:userId", supportRateLimit, requireAdmin, async (req, res) => {
  const userId = z.coerce.number().int().positive().safeParse(req.params.userId);
  if (!userId.success) {
    res.status(400).json({ error: "Identifiant étudiant invalide." });
    return;
  }
  const input = parseBody(supportMessageSchema, req.body, res);
  if (!input) return;
  const student = await database.one<{ id: number; name: string; email: string }>(`
    SELECT id, name, email FROM users
    WHERE id = ? AND role = 'student'
  `, userId.data);
  if (!student) {
    res.status(404).json({ error: "Étudiant introuvable." });
    return;
  }
  const adminId = req.userId;
  if (adminId === undefined) {
    res.status(401).json({ error: "Connectez-vous pour continuer." });
    return;
  }
  const result = await database.one<{ id: number }>(`
    INSERT INTO support_messages (user_id, sender_id, body)
    VALUES (?, ?, ?)
    RETURNING id
  `, student.id, adminId, input.body);
  if (!result) throw new Error("L’enregistrement du message n’a pas retourné son identifiant.");
  const message = await database.one(`
    SELECT m.id, m.user_id AS userId, m.sender_id AS senderId,
      u.name AS senderName, u.role AS senderRole, m.body, m.created_at AS createdAt
    FROM support_messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `, result.id);
  res.status(201).json({ message, recipient: { name: student.name, email: student.email } });
});

const adminDashboardQuerySchema = z.object({
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
});

app.get("/api/admin/dashboard", requireAdmin, async (req, res) => {
  const parsed = adminDashboardQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Sélectionnez une date et un créneau valides." });
    return;
  }

  const startsAt = new Date(parsed.data.startsAt).toISOString();
  const endsAt = new Date(parsed.data.endsAt).toISOString();
  if (Date.parse(startsAt) >= Date.parse(endsAt)) {
    res.status(400).json({ error: "L’heure de fin doit être après l’heure de début." });
    return;
  }

  const rooms = await database.many(`
    SELECT r.id, r.name, r.building, r.capacity, r.accessible, r.equipment, r.active,
      CASE WHEN r.active = 1 AND NOT EXISTS (
        SELECT 1 FROM reservations b
        WHERE b.room_id = r.id
          AND b.status = 'confirmed'
          AND b.starts_at < ?
          AND b.ends_at > ?
      ) THEN 1 ELSE 0 END AS available
    FROM rooms r
    ORDER BY r.active DESC, available DESC, r.name
  `, endsAt, startsAt);

  const reservations = await database.many(`
    SELECT b.id, b.room_id AS roomId, b.starts_at AS startsAt, b.ends_at AS endsAt, b.status,
      r.name AS roomName, r.building, u.id AS userId, u.name AS userName, u.email AS userEmail
    FROM reservations b
    JOIN rooms r ON r.id = b.room_id
    JOIN users u ON u.id = b.user_id
    ORDER BY b.starts_at DESC
  `);

  const slotReservations = await database.many(`
    SELECT b.id, b.room_id AS roomId, b.starts_at AS startsAt, b.ends_at AS endsAt, b.status,
      r.name AS roomName, r.building, u.id AS userId, u.name AS userName, u.email AS userEmail
    FROM reservations b
    JOIN rooms r ON r.id = b.room_id
    JOIN users u ON u.id = b.user_id
    WHERE b.status = 'confirmed'
      AND b.starts_at < ?
      AND b.ends_at > ?
    ORDER BY b.starts_at
  `, endsAt, startsAt);

  const favorites = await database.many(`
    SELECT u.id AS userId, u.name AS userName, u.email AS userEmail,
      r.id AS roomId, r.name AS roomName, r.building
    FROM room_favorites f
    JOIN users u ON u.id = f.user_id
    JOIN rooms r ON r.id = f.room_id
    WHERE u.role = 'student'
    ORDER BY u.name, r.name
  `);

  res.json({ rooms, reservations, slotReservations, favorites });
});

const roomSchema = z.object({
  name: z.string().trim().min(2).max(80),
  building: z.string().trim().min(2).max(120),
  capacity: z.number().int().min(1).max(1000),
  accessible: z.boolean(),
  equipment: z.string().trim().max(300),
  active: z.boolean().optional(),
});

app.get("/api/admin/rooms", requireAdmin, async (_req, res) => {
  const rooms = await database.many(`
    SELECT id, name, building, capacity, accessible, equipment, active
    FROM rooms
    ORDER BY active DESC, name
  `);
  res.json({ rooms });
});

app.post("/api/admin/rooms", requireAdmin, async (req, res) => {
  const input = parseBody(roomSchema.omit({ active: true }), req.body, res);
  if (!input) return;
  try {
    const result = await database.one<{ id: number }>(`
      INSERT INTO rooms (name, building, capacity, accessible, equipment, active)
      VALUES (?, ?, ?, ?, ?, 1)
      RETURNING id
    `, input.name, input.building, input.capacity, input.accessible ? 1 : 0, input.equipment);
    if (!result) throw new Error("La création de la salle n’a pas retourné son identifiant.");
    res.status(201).json({ id: result.id });
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Une salle porte déjà ce nom." });
      return;
    }
    throw error;
  }
});

app.put("/api/admin/rooms/:id", requireAdmin, async (req, res) => {
  const roomId = z.coerce.number().int().positive().safeParse(req.params.id);
  if (!roomId.success) {
    res.status(400).json({ error: "Identifiant de salle invalide." });
    return;
  }
  const input = parseBody(roomSchema, req.body, res);
  if (!input) return;
  try {
    const result = await database.run(`
      UPDATE rooms
      SET name = ?, building = ?, capacity = ?, accessible = ?, equipment = ?, active = ?
      WHERE id = ?
    `, input.name, input.building, input.capacity, input.accessible ? 1 : 0, input.equipment, input.active === false ? 0 : 1, roomId.data);
    if (result.changes === 0) {
      res.status(404).json({ error: "Salle introuvable." });
      return;
    }
    res.status(204).end();
  } catch (error) {
    if (isUniqueViolation(error)) {
      res.status(409).json({ error: "Une salle porte déjà ce nom." });
      return;
    }
    throw error;
  }
});

app.delete("/api/admin/rooms/:id", requireAdmin, async (req, res) => {
  const roomId = z.coerce.number().int().positive().safeParse(req.params.id);
  if (!roomId.success) {
    res.status(400).json({ error: "Identifiant de salle invalide." });
    return;
  }
  const result = await database.run("UPDATE rooms SET active = 0 WHERE id = ? AND active = 1", roomId.data);
  if (result.changes === 0) {
    res.status(404).json({ error: "Salle active introuvable." });
    return;
  }
  res.status(204).end();
});

app.get("/api/admin/settings", requireAdmin, async (_req, res) => {
  res.json({ rules: await getReservationRules() });
});

const rulesSchema = z.object({
  minDurationMinutes: z.number().int().min(30).max(240).multipleOf(30),
  maxDurationMinutes: z.number().int().min(30).max(240).multipleOf(30),
  minNoticeMinutes: z.number().int().min(0).max(43_200).multipleOf(30),
}).refine((rules) => rules.minDurationMinutes <= rules.maxDurationMinutes, {
  message: "La durée minimale doit être inférieure ou égale à la durée maximale.",
  path: ["minDurationMinutes"],
});

app.put("/api/admin/settings", requireAdmin, async (req, res) => {
  const input = parseBody(rulesSchema, req.body, res);
  if (!input) return;
  await transaction(async (connection) => {
    const update = "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
    await connection.run(update, "min_duration_minutes", String(input.minDurationMinutes));
    await connection.run(update, "max_duration_minutes", String(input.maxDurationMinutes));
    await connection.run(update, "min_notice_minutes", String(input.minNoticeMinutes));
  });
  res.status(204).end();
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Route introuvable." });
});

if (process.env.NODE_ENV === "production" && !process.env.VERCEL) {
  const clientDirectory = path.resolve("dist/client");
  app.use(express.static(clientDirectory));
  app.get("/{*path}", (_req, res) => res.sendFile(path.join(clientDirectory, "index.html")));
}

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`API démarrée sur http://localhost:${port}`);
  });
}

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error("Erreur API :", error);
  if (res.headersSent) return;
  const message = process.env.NODE_ENV === "production" ? "Une erreur interne est survenue." : "Erreur interne du serveur.";
  res.status(500).json({ error: message, path: req.path });
});

export default app;
