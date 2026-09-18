/* Runs on a schedule from GitHub Actions. Reads the schedule, the dose log and
   the registered phones, works out what each person should hear about, and sends it.
   Sends nothing twice: every notification claims a marker document first, so a
   late or duplicated run stays quiet. */

process.env.TZ = process.env.HOUSE_TZ || "America/New_York";

const admin = require("firebase-admin");

const SPACE = process.env.HOUSE_CODE;
const LEAD_MIN = Number(process.env.LEAD_MINUTES || 20);   // how far ahead "coming up" fires
const GRACE_MIN = Number(process.env.GRACE_MINUTES || 30); // how late before "overdue" fires
const COUNT_HOUR = Number(process.env.COUNT_CHECK_HOUR || 19);

const MIN = 60000, HOUR = 3600000;
const fmt = ms => new Date(ms).toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit"});

if (!SPACE) { console.error("HOUSE_CODE is not set"); process.exit(1); }

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();
const base = `spaces/${SPACE}`;

const todayStr = (d = new Date()) =>
  d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
  "-" + String(d.getDate()).padStart(2, "0");

const activeNow = it => {
  const t = todayStr();
  return (!it.from || it.from <= t) && (!it.until || it.until >= t);
};

/* Scheduled times for a fixed item, across yesterday/today/tomorrow. */
/* Times are stored as minutes past midnight (Firestore can't nest arrays).
   Older records used [hour, minute] pairs, so both are accepted. */
const toHM = v => Array.isArray(v) ? v : [Math.floor(Number(v) / 60), Number(v) % 60];

function anchorsAround(item, ms) {
  const b = new Date(ms), out = [];
  for (let d = -1; d <= 1; d++)
    for (const a of item.anchors || []) {
      const [h, mi] = toHM(a);
      out.push(new Date(b.getFullYear(), b.getMonth(), b.getDate() + d, h, mi).getTime());
    }
  return out.sort((a, z) => a - z);
}
const nearestAnchor = (item, ms) =>
  anchorsAround(item, ms).reduce((best, a) => Math.abs(a - ms) < Math.abs(best - ms) ? a : best);

/* Claim a marker. Returns false if this notification already went out. */
async function claim(id) {
  try {
    await db.doc(`${base}/notified/${id}`).create({at: Date.now()});
    return true;
  } catch (e) {
    return false;   // already exists
  }
}

function wants(dev, type, itemKey) {
  if (!dev.enabled || !dev.token) return false;
  if (!(dev.types || {})[type]) return false;
  if (dev.items === "all" || dev.items === undefined) return true;
  return Array.isArray(dev.items) && dev.items.includes(itemKey);
}

async function send(devices, title, body, tag) {
  if (!devices.length) return;
  const tokens = devices.map(d => d.token);
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    data: {title, body, tag: tag || "", url: "/"},
    webpush: {headers: {Urgency: "high"}, fcmOptions: {link: "/"}}
  });
  console.log(`  -> ${title} | ${body} | ${res.successCount}/${tokens.length} delivered`);

  // Drop phones that have uninstalled or reset — their tokens are dead for good.
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-argument") {
      console.log(`     removing dead token for ${devices[i].name}`);
      db.doc(`${base}/devices/${devices[i].id}`).delete().catch(() => {});
    }
  });
}

async function main() {
  const now = Date.now();

  const cfg = await db.doc(`${base}/config/schedule`).get();
  const items = ((cfg.exists && cfg.data().meds) || []).filter(activeNow);
  if (!items.length) { console.log("No active items."); return; }

  const doseSnap = await db.collection(`${base}/doses`).where("at", ">", now - 2 * 24 * HOUR).get();
  const doses = doseSnap.docs.map(d => Object.assign({id: d.id}, d.data()));

  const devSnap = await db.collection(`${base}/devices`).get();
  const devices = devSnap.docs.map(d => Object.assign({id: d.id}, d.data()));
  if (!devices.length) { console.log("No registered phones."); return; }

  console.log(`${items.length} active items, ${devices.length} phones, ${doses.length} recent doses`);

  const covered = (item, T) => doses.some(e =>
    e.key === item.key && (e.slot ? e.slot === T : nearestAnchor(item, e.at) === T));
  const lastOf = key => doses.filter(e => e.key === key).sort((a, b) => b.at - a.at)[0];

  for (const item of items) {
    const style = item.sched || "fixed";

    /* --- a set time, or an interval counted from the last one --- */
    if (style === "fixed" || style === "interval") {
      let times;
      if (style === "fixed") {
        times = anchorsAround(item, now).filter(T => T > now - 6 * HOUR && T < now + 2 * HOUR);
      } else {
        const prev = lastOf(item.key);
        times = prev ? [prev.at + (Number(item.everyH) || 4) * HOUR] : [];
      }

      for (const T of times) {
        const due = T - now;

        // Coming up. The window is wide on purpose: GitHub's scheduler runs late,
        // and a reminder 12 minutes ahead beats no reminder at all.
        if (due > 0 && due <= LEAD_MIN * MIN && !covered(item, T)) {
          const to = devices.filter(d => wants(d, "due", item.key));
          if (to.length && await claim(`due-${item.key}-${T}`))
            await send(to, `${item.name} at ${fmt(T)}`,
              `${item.dose || "Coming up"} — in ${Math.round(due / MIN)} minutes`,
              `due-${item.key}`);
        }

        // Overdue and still not logged.
        if (due < -GRACE_MIN * MIN && !covered(item, T)) {
          const to = devices.filter(d => wants(d, "overdue", item.key));
          if (to.length && await claim(`late-${item.key}-${T}`))
            await send(to, `${item.name} not logged`,
              `Was due at ${fmt(T)}, ${Math.round(-due / MIN)} minutes ago`,
              `late-${item.key}`);
        }
      }
    }

    /* --- N times a day with no set time: one check in the evening --- */
    if (style === "count") {
      const hour = new Date(now).getHours();
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      const done = doses.filter(e => e.key === item.key && e.at >= start.getTime()).length;
      const target = Number(item.perDay) || 3;
      if (hour === COUNT_HOUR && done < target) {
        const to = devices.filter(d => wants(d, "overdue", item.key));
        if (to.length && await claim(`count-${item.key}-${todayStr()}`))
          await send(to, `${item.name}: ${done} of ${target} today`,
            `${target - done} still to do`, `count-${item.key}`);
      }
    }
  }

  /* --- someone else logged one --- */
  for (const e of doses.filter(e => e.at > now - 40 * MIN && e.by)) {
    const item = items.find(i => i.key === e.key);
    if (!item) continue;
    const to = devices.filter(d =>
      wants(d, "logged", e.key) && (d.name || "").toLowerCase() !== String(e.by).toLowerCase());
    if (to.length && await claim(`log-${e.id}`))
      await send(to, `${e.by} gave ${item.name}`, `Logged at ${fmt(e.at)}`, `log-${e.key}`);
  }

  /* --- tidy up old markers --- */
  const stale = await db.collection(`${base}/notified`)
    .where("at", "<", now - 3 * 24 * HOUR).limit(200).get();
  if (!stale.empty) {
    const batch = db.batch();
    stale.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`cleared ${stale.size} old markers`);
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
