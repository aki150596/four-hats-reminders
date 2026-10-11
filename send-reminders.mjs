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
    // Mark the task as reminded so open apps don't fire it again, then clear the job.
    await db.collection("users").doc(r.uid).collection("tasks").doc(r.taskId)
      .update({ reminded: true }).catch(() => {});
    await doc.ref.delete();
    sent++;
  }
  if (sent) console.log(`${new Date().toISOString()}  sent ${sent} reminder(s) to ${devices} device(s)`);
}

const started = Date.now();
for (;;) {
  await sendDue();
  if (Date.now() - started + EVERY > RUN_FOR) break;
  await new Promise(r => setTimeout(r, EVERY));
}
