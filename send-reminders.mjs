// Four Hats: sends due reminders as push notifications.
// Runs on GitHub Actions every 5 minutes (see .github/workflows/reminders.yml).
// Each run keeps checking every 30 seconds for RUN_FOR_SECONDS, so reminders
// usually land within a minute or two of their time.
//
// The repository is public, so this script never logs task titles or user ids.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

let account;
try { account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ""); } catch { account = null; }
if (!account || !account.project_id) {
  console.error("The FIREBASE_SERVICE_ACCOUNT secret is missing or isn't the JSON key file. See README.md.");
  process.exit(1);
}

initializeApp({ credential: cert(account) });
const db = getFirestore();
const fcm = getMessaging();

const APP_URL = process.env.APP_URL || `https://${account.project_id}.firebaseapp.com/`;
const RUN_FOR = Number(process.env.RUN_FOR_SECONDS || 0) * 1000;
const EVERY = 30 * 1000;
const DEAD_TOKEN = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

const STEP = { hourly: 3600e3, daily: 864e5, weekly: 7 * 864e5 };

// "YYYY-MM-DDTHH:MM" in the person's time zone, the format the app stores.
function localStamp(ms, tz) {
  let fmt;
  try { fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  catch { fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); }
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

async function sendDue() {
  const due = await db.collection("reminders").where("at", "<=", Date.now()).limit(300).get();
  let sent = 0, devices = 0;
  for (const doc of due.docs) {
    const r = doc.data();
    const devSnap = await db.collection("users").doc(r.uid).collection("devices").get();
    const targets = devSnap.docs.map(d => ({ ref: d.ref, token: d.get("token") })).filter(x => x.token);
    if (targets.length) {
      const res = await fcm.sendEachForMulticast({
        tokens: targets.map(x => x.token),
        data: {
          title: String(r.title || "Reminder"),
          body: r.hat ? `${r.hat} · reminder` : "Reminder",
          tag: `task-${r.taskId}`,
          url: APP_URL,
        },
        webpush: { headers: { Urgency: "high", TTL: "21600" } },
      });
      res.responses.forEach((x, i) => {
        if (!x.success && DEAD_TOKEN.has(x.error?.code)) targets[i].ref.delete().catch(() => {});
      });
      devices += res.successCount;
    }
    const taskRef = db.collection("users").doc(r.uid).collection("tasks").doc(r.taskId);
    const step = STEP[r.repeat];
    if (step) {
      // Repeating reminder: schedule the next one (in the person's own time zone) and keep the entry.
      let next = r.at;
      do { next += step; } while (next <= Date.now());
      const ok = await taskRef.update({ remindAt: localStamp(next, r.tz), reminded: false }).then(() => true, () => false);
      if (ok) await doc.ref.update({ at: next });
      else await doc.ref.delete();   // the task is gone
    } else {
      // One-off: mark the task as reminded so open apps don't fire it again, then clear the entry.
      await taskRef.update({ reminded: true }).catch(() => {});
      await doc.ref.delete();
    }
    sent++;
  }
  if (sent) console.log(`${new Date().toISOString()}  sent ${sent} reminder(s) to ${devices} device(s)`);
}

// Nudges from friends: push each new one to the person's devices once.
async function sendNudges() {
  const fresh = await db.collection("nudges").where("pushed", "==", false).limit(200).get();
  let sent = 0;
  for (const doc of fresh.docs) {
    const n = doc.data();
    await doc.ref.update({ pushed: true });
    if (n.seen) continue;   // already seen in the open app
    const devSnap = await db.collection("users").doc(n.to).collection("devices").get();
    const targets = devSnap.docs.map(d => ({ ref: d.ref, token: d.get("token") })).filter(x => x.token);
    if (!targets.length) continue;
    const res = await fcm.sendEachForMulticast({
      tokens: targets.map(x => x.token),
      data: {
        title: `${String(n.fromName || "Someone")} nudged you`,
        body: String(n.message || "") + (n.taskTitle ? ` · ${n.taskTitle}` : ""),
        tag: `nudge-${doc.id}`,
        url: APP_URL,
      },
      webpush: { headers: { Urgency: "normal", TTL: "86400" } },
    });
    res.responses.forEach((x, i) => {
      if (!x.success && DEAD_TOKEN.has(x.error?.code)) targets[i].ref.delete().catch(() => {});
    });
    sent++;
  }
  if (sent) console.log(`${new Date().toISOString()}  pushed ${sent} nudge(s)`);
}

// Nudges older than two weeks are cleared so the collection stays small.
async function cleanOldNudges() {
  const old = await db.collection("nudges").where("at", "<", Date.now() - 14 * 864e5).limit(300).get();
  await Promise.all(old.docs.map(d => d.ref.delete()));
}

const started = Date.now();
await cleanOldNudges().catch(e => console.error("Couldn't clear old nudges:", e.message));
for (;;) {
  await sendDue();
  await sendNudges();
  if (Date.now() - started + EVERY > RUN_FOR) break;
  await new Promise(r => setTimeout(r, EVERY));
}
