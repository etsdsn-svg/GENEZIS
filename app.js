// ============================================================
// GENEZIS — Application
// Toute la logique métier validée dans le modèle fonctionnel :
// - prix figés sur le voyage à la création (jamais rétroactifs)
// - dépassement de ligne de BC → scission avec confirmation
// - référentiels créés à la volée, contrôle de doublon
// - gasoil/péage/restauration/réparations récupérés à 100%
// - voyage en deux temps : départ (charge) → livraison (livre)
// ============================================================

const SUPABASE_URL = "https://rfkygibfxmxazcxqsciv.supabase.co";
const SUPABASE_KEY = "sb_publishable_PLtcSrHOyWx6s9U4sVMr6Q_tBO-bLMT";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let CURRENT_USER = null;   // { id, nom, role }
let CURRENT_SCREEN = "dashboard";

// ---------- Utilitaires ----------
function fmt(n, dec = 0) {
  n = Number(n) || 0;
  return n.toLocaleString("fr-FR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  return dt.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtDateTime(d) {
  if (!d) return "—";
  const dt = new Date(d);
  return dt.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) + " · " +
         dt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }
document.querySelectorAll(".overlay").forEach(ov => {
  ov.addEventListener("click", e => { if (e.target === ov) ov.hidden = true; });
});

// ---------- Compression photo (capture locale, sync différée) ----------
// Stockage réel : voir §11 du modèle. Ici, compression avant upload direct
// (la file d'attente hors-ligne complète est un développement ultérieur ;
// ce socle prépare le terrain : compression + statut de synchronisation).
function compressImage(file, maxDim = 1400, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = e => { img.src = e.target.result; };
    reader.onerror = reject;
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height = height * maxDim / width; width = maxDim; }
      else if (height > maxDim) { width = width * maxDim / height; height = maxDim; }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => resolve(blob), "image/jpeg", quality);
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadPhoto(blob, path) {
  const { data, error } = await sb.storage.from("photos-voyages").upload(path, blob, {
    contentType: "image/jpeg", upsert: true
  });
  if (error) { console.error(error); return null; }
  const { data: pub } = sb.storage.from("photos-voyages").getPublicUrl(path);
  return pub.publicUrl;
}

function photoSlotHTML(inputId, label = "Photographier le ticket") {
  return `
    <div class="photo-slot" id="${inputId}-slot">
      <div class="icon">📷</div>
      <span class="txt">${label}</span>
      <span class="txt2">Compressée automatiquement avant envoi</span>
      <input type="file" id="${inputId}" accept="image/*" capture="environment">
    </div>`;
}
function wirePhotoSlot(inputId, onReady) {
  const input = document.getElementById(inputId);
  const slot = document.getElementById(inputId + "-slot");
  slot.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    slot.innerHTML = `<span class="txt2">Compression en cours…</span>`;
    try {
      const blob = await compressImage(file);
      const url = URL.createObjectURL(blob);
      slot.outerHTML = `
        <div class="photo-done" id="${inputId}-slot">
          <img src="${url}" alt="">
          <div class="info"><b>Photo prête</b><span>En attente d'envoi · sera synchronisée</span></div>
          <button type="button" id="${inputId}-retake">Reprendre</button>
        </div>`;
      document.getElementById(inputId + "-retake").addEventListener("click", () => {
        document.getElementById(inputId + "-slot").outerHTML = photoSlotHTML(inputId, onReady._label || "Photographier");
        wirePhotoSlot(inputId, onReady);
      });
      onReady(blob);
    } catch (err) {
      console.error(err);
      toast("Impossible de traiter la photo");
    }
  });
}

// ============================================================
// AUTHENTIFICATION
// ============================================================
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    await loadCurrentUser(session.user.id, session.user.email);
  }
  document.getElementById("boot").remove();
  if (CURRENT_USER) {
    showApp();
  } else {
    document.getElementById("authscreen").hidden = false;
  }
}

async function loadCurrentUser(userId, email) {
  let { data } = await sb.from("utilisateurs").select("*").eq("id", userId).maybeSingle();
  if (!data) {
    // Premier utilisateur créé automatiquement comme client (accès total)
    const { data: created } = await sb.from("utilisateurs")
      .insert({ id: userId, nom: email.split("@")[0], role: "client" })
      .select().single();
    data = created;
  }
  CURRENT_USER = data;
}

let AUTH_MODE = "login"; // "login" | "signup"

document.getElementById("auth-toggle").addEventListener("click", () => {
  AUTH_MODE = AUTH_MODE === "login" ? "signup" : "login";
  document.getElementById("auth-sub").textContent =
    AUTH_MODE === "login" ? "Transport d'agrégats — connexion" : "Transport d'agrégats — création de compte";
  document.getElementById("auth-submit").textContent =
    AUTH_MODE === "login" ? "Se connecter" : "Créer mon compte";
  document.getElementById("auth-toggle").textContent =
    AUTH_MODE === "login" ? "Pas encore de compte ? Créer un compte" : "Déjà un compte ? Se connecter";
  document.getElementById("auth-pass-hint").hidden = AUTH_MODE === "login";
  document.getElementById("auth-err").textContent = "";
});

document.getElementById("auth-submit").addEventListener("click", async () => {
  const email = document.getElementById("auth-email").value.trim();
  const pass = document.getElementById("auth-pass").value;
  const errEl = document.getElementById("auth-err");
  errEl.textContent = "";
  if (!email || !pass) { errEl.textContent = "Adresse e-mail et mot de passe requis."; return; }
  if (AUTH_MODE === "signup" && pass.length < 6) { errEl.textContent = "Le mot de passe doit faire au moins 6 caractères."; return; }

  document.getElementById("auth-submit").disabled = true;

  if (AUTH_MODE === "signup") {
    const { data, error } = await sb.auth.signUp({ email, password: pass });
    if (error) {
      errEl.textContent = error.message.includes("already registered")
        ? "Un compte existe déjà avec cette adresse — connectez-vous plutôt."
        : error.message;
      document.getElementById("auth-submit").disabled = false;
      return;
    }
    if (!data.session) {
      errEl.textContent = "Compte créé. Vérifiez votre e-mail pour confirmer, puis connectez-vous.";
      document.getElementById("auth-submit").disabled = false;
      return;
    }
    await loadCurrentUser(data.user.id, data.user.email);
  } else {
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error) {
      errEl.textContent = "E-mail ou mot de passe incorrect.";
      document.getElementById("auth-submit").disabled = false;
      return;
    }
    await loadCurrentUser(data.user.id, data.user.email);
  }

  document.getElementById("authscreen").hidden = true;
  showApp();
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

function showApp() {
  document.getElementById("who-name").textContent = CURRENT_USER.nom + " · " + (CURRENT_USER.role === "client" ? "Client" : "Assistant");
  document.getElementById("app").hidden = false;
  wireNav();
  goScreen("dashboard");
}

// ============================================================
// NAVIGATION
// ============================================================
function wireNav() {
  document.querySelectorAll("#tabs button").forEach(b => {
    b.addEventListener("click", () => goScreen(b.dataset.screen));
  });
  document.getElementById("fab-voyage").addEventListener("click", () => openVoyageModal());
  document.getElementById("btn-back-bcs").addEventListener("click", () => goScreen("bcs"));
  document.getElementById("btn-back-transporteurs").addEventListener("click", () => goScreen("transporteurs"));
  document.getElementById("btn-new-bc").addEventListener("click", () => openBcModal());
  document.getElementById("btn-new-transporteur").addEventListener("click", () => openTransporteurModal());
}

function goScreen(name) {
  CURRENT_SCREEN = name;
  document.querySelectorAll(".screen").forEach(s => s.hidden = true);
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.screen === name));
  const el = document.getElementById("s-" + name);
  if (el) el.hidden = false;

  if (name === "dashboard") renderDashboard();
  if (name === "attente") renderAttente();
  if (name === "bcs") renderBcs();
  if (name === "transporteurs") renderTransporteurs();
}

// ============================================================
// TABLEAU DE BORD
// ============================================================
async function renderDashboard() {
  const el = document.getElementById("dash-content");
  el.innerHTML = `<div class="loading">Chargement…</div>`;

  const [{ data: voyages }, { data: lignes }, { data: mouv }] = await Promise.all([
    sb.from("voyages").select("*").order("date_chargement", { ascending: false }).limit(500),
    sb.from("lignes_bc").select("*, produits(taille), bons_commande(numero, statut)"),
    sb.from("mouvements_transporteur").select("*")
  ]);

  const now = new Date();
  const debutMois = new Date(now.getFullYear(), now.getMonth(), 1);
  const voyagesMois = (voyages || []).filter(v => new Date(v.date_chargement) >= debutMois);

  const tonnageMois = voyagesMois.reduce((s, v) => s + Number(v.tonnage_net_kg || 0), 0) / 1000;
  const nbVoyages = voyagesMois.length;
  const aValoriser = voyagesMois.filter(v => !v.trajet_id).length;

  const aEncaisser = voyagesMois.reduce((s, v) => {
    if (!v.prix_vente_applique) return s;
    return s + (Number(v.tonnage_net_kg) / 1000) * Number(v.prix_vente_applique);
  }, 0);

  const total = { dus: 0, decaisse: 0 };
  voyagesMois.forEach(v => {
    if (v.prix_transporteur_applique) total.dus += (Number(v.tonnage_net_kg) / 1000) * Number(v.prix_transporteur_applique);
    total.decaisse += Number(v.peage_applique || 0) + Number(v.restauration_appliquee || 0);
  });
  const avancesMois = (mouv || []).filter(m => m.type !== "paiement").reduce((s, m) => s + Number(m.montant), 0);
  const resteAPayer = total.dus - avancesMois;

  const enAttente = (voyages || []).filter(v => v.statut === "charge").length;

  el.innerHTML = `
    <div class="card">
      <p class="card-label">Tonnage livré ce mois</p>
      <p class="stat">${fmt(tonnageMois, 2)}<span class="unit">t</span></p>
      <p class="card-foot">${nbVoyages} voyage${nbVoyages > 1 ? "s" : ""}</p>
    </div>
    <div class="card">
      <p class="card-label">À encaisser (estimation)</p>
      <p class="stat pos">${fmt(aEncaisser)}<span class="unit">F</span></p>
      <p class="card-foot">Voyages valorisés du mois</p>
    </div>
    <div class="card">
      <p class="card-label">Reste à payer aux transporteurs</p>
      <p class="stat ${resteAPayer < 0 ? "pos" : "neg"}">${fmt(Math.abs(resteAPayer))}<span class="unit">F</span></p>
      <p class="card-foot">${resteAPayer < 0 ? "Créance à récupérer" : "après avances et décaissements"}</p>
    </div>
    <div class="card span-all">
      <p class="card-label">Voyages en attente de livraison</p>
      <p class="stat">${enAttente}</p>
      <p class="card-foot">${enAttente > 0 ? "Consultez l'onglet « En attente »" : "Rien en attente"}</p>
    </div>
    ${aValoriser > 0 ? `
    <div class="card span-all" style="border-color:var(--amber)">
      <p class="card-label" style="color:var(--amber)">⚠ Voyages à valoriser</p>
      <p class="stat">${aValoriser}</p>
      <p class="card-foot">Sans prix appliqué — le mois ne pourra pas être clôturé tant qu'il en reste.</p>
    </div>` : ""}
  `;
}

// ============================================================
// VOYAGES EN ATTENTE DE LIVRAISON
// ============================================================
async function renderAttente() {
  const el = document.getElementById("attente-content");
  el.innerHTML = `<div class="loading">Chargement…</div>`;

  const { data: voyages, error } = await sb.from("voyages")
    .select("*, camions(immatriculation, transporteurs(nom)), lignes_bc(produit_id, produits(taille))")
    .eq("statut", "charge")
    .order("date_chargement", { ascending: true });

  if (error) { el.innerHTML = `<div class="empty">Erreur de chargement.</div>`; console.error(error); return; }
  if (!voyages || voyages.length === 0) { el.innerHTML = `<div class="empty">Aucun voyage en attente de livraison.</div>`; return; }

  const now = Date.now();
  el.innerHTML = voyages.map(v => {
    const heures = (now - new Date(v.date_chargement).getTime()) / 3600000;
    const badge = heures > 24
      ? `<span class="badge charge">Depuis ${Math.floor(heures / 24)} j</span>`
      : `<span class="badge charge">En route</span>`;
    return `
      <div class="row" data-id="${v.id}">
        <div class="top">
          <div>
            <div class="id">${esc(v.camions?.immatriculation || "—")}</div>
            <div class="sub">${esc(v.camions?.transporteurs?.nom || "")} · ${esc(v.lignes_bc?.produits?.taille || "")} · chargé ${fmtDateTime(v.date_chargement)}</div>
          </div>
          <div class="right">
            <span class="amt">${fmt(v.tonnage_net_kg)} kg</span>
            ${badge}
          </div>
        </div>
      </div>`;
  }).join("");

  el.querySelectorAll(".row").forEach(r => {
    r.addEventListener("click", () => openLivraisonModal(r.dataset.id));
  });
}

// ============================================================
// RÉFÉRENTIELS — recherche + création à la volée
// ============================================================
async function searchOrCreate(table, field, query, extra = {}) {
  if (!query || query.length < 1) return [];
  const { data } = await sb.from(table).select("*").ilike(field, `%${query}%`).limit(6);
  return data || [];
}

function wireSuggest(inputId, table, field, { extraFilter = null, onPick, allowCreate = true, createExtra = () => ({}) } = {}) {
  const input = document.getElementById(inputId);
  const wrap = input.closest(".suggestwrap");
  let box = wrap.querySelector(".suggest");
  let selected = null;

  input.addEventListener("input", async () => {
    selected = null;
    const q = input.value.trim();
    if (!q) { box.hidden = true; return; }
    let query = sb.from(table).select("*").ilike(field, `%${q}%`).limit(6);
    if (extraFilter) query = extraFilter(query);
    const { data } = await query;
    const items = data || [];
    const exact = items.some(i => i[field].toLowerCase() === q.toLowerCase());
    let html = items.map(i => `<div data-id="${i.id}" data-val="${esc(i[field])}">${esc(i[field])}<span class="sub">existant</span></div>`).join("");
    if (allowCreate && !exact && q.length >= 2) {
      html += `<div class="new" data-create="1">+ Créer « ${esc(q)} »</div>`;
    }
    box.innerHTML = html || `<div class="sub" style="padding:11px 13px">Aucun résultat</div>`;
    box.hidden = false;
  });

  box.addEventListener("click", async (e) => {
    const row = e.target.closest("div[data-id],div[data-create]");
    if (!row) return;
    if (row.dataset.create) {
      const q = input.value.trim();
      const insertData = { [field]: q, cree_par: CURRENT_USER.id, ...createExtra() };
      const { data, error } = await sb.from(table).insert(insertData).select().single();
      if (error) { toast("Erreur : " + error.message); return; }
      selected = data;
      input.value = data[field];
    } else {
      selected = { id: row.dataset.id, [field]: row.dataset.val };
      input.value = row.dataset.val;
    }
    box.hidden = true;
    if (onPick) onPick(selected);
  });

  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) box.hidden = true;
  });

  return () => selected;
}

// ============================================================
// NOUVEAU VOYAGE — DÉPART
// ============================================================
let voyageState = {};

async function openVoyageModal() {
  voyageState = { photoBlob: null };
  const content = document.getElementById("voyage-form-content");
  content.innerHTML = `
    <div class="form-grid">
      <div class="field span-all">
        <label>Ticket de bascule</label>
        ${photoSlotHTML("v-photo", "Photographier le ticket")}
      </div>
      <div class="field suggestwrap">
        <label>Camion</label>
        <input class="control" id="v-camion" placeholder="Immatriculation" autocomplete="off">
        <div class="suggest" hidden></div>
        <p class="hint">Choisissez toujours la fiche existante — un camion écrit de deux façons compte pour deux camions.</p>
      </div>
      <div class="field suggestwrap">
        <label>Site de production</label>
        <input class="control" id="v-site" placeholder="Carrière" autocomplete="off">
        <div class="suggest" hidden></div>
      </div>
      <div class="field suggestwrap">
        <label>Produit</label>
        <input class="control" id="v-produit" placeholder="Ex. 5/15" autocomplete="off">
        <div class="suggest" hidden></div>
      </div>
      <div class="field suggestwrap">
        <label>Chantier de destination</label>
        <input class="control" id="v-chantier" placeholder="Chantier" autocomplete="off">
        <div class="suggest" hidden></div>
      </div>
      <div class="field">
        <label>Tonnage net du ticket (kg)</label>
        <input class="control big" id="v-tonnage" type="number" placeholder="0">
      </div>
      <div class="field">
        <label>Date et heure de chargement</label>
        <input class="control" id="v-datetime" type="datetime-local">
      </div>
      <div class="field span-all suggestwrap">
        <label>Bon de commande (client)</label>
        <input class="control" id="v-client" placeholder="Rechercher un client" autocomplete="off">
        <div class="suggest" hidden></div>
        <p class="hint" id="v-bc-hint">Le client détermine la ligne de BC proposée.</p>
      </div>
    </div>
    <div class="actions">
      <button class="btn" id="v-submit">Enregistrer le départ</button>
      <button class="btn ghost" id="v-cancel">Annuler</button>
    </div>
  `;
  document.getElementById("v-datetime").value = new Date().toISOString().slice(0, 16);

  wirePhotoSlot("v-photo", (blob) => { voyageState.photoBlob = blob; });

  const getCamion = wireSuggest("v-camion", "camions", "immatriculation", {
    allowCreate: true,
    createExtra: () => ({ transporteur_id: null }) // affiné si besoin ; simplifié pour le socle
  });
  const getSite = wireSuggest("v-site", "sites_production", "nom");
  let currentSite = null;
  wireSuggest("v-site", "sites_production", "nom", { onPick: (s) => { currentSite = s; } });

  const getProduit = wireSuggest("v-produit", "produits", "taille", {
    extraFilter: (q) => currentSite ? q.eq("site_id", currentSite.id) : q,
    allowCreate: true,
    createExtra: () => currentSite ? { site_id: currentSite.id } : {}
  });

  let currentClient = null;
  wireSuggest("v-client", "clients", "nom", { onPick: (c) => { currentClient = c; } });

  let currentChantier = null;
  wireSuggest("v-chantier", "chantiers", "nom", {
    extraFilter: (q) => currentClient ? q.eq("client_id", currentClient.id) : q,
    allowCreate: true,
    createExtra: () => currentClient ? { client_id: currentClient.id } : {}
  });

  document.getElementById("v-cancel").addEventListener("click", () => closeModal("modal-voyage"));
  document.getElementById("v-submit").addEventListener("click", async () => {
    await submitDepart({ currentClient: () => currentClient, currentSite: () => currentSite, currentChantier: () => currentChantier });
  });

  openModal("modal-voyage");
}

async function submitDepart(refs) {
  const camionNom = document.getElementById("v-camion").value.trim();
  const siteNom = document.getElementById("v-site").value.trim();
  const produitNom = document.getElementById("v-produit").value.trim();
  const chantierNom = document.getElementById("v-chantier").value.trim();
  const tonnage = parseFloat(document.getElementById("v-tonnage").value);
  const datetime = document.getElementById("v-datetime").value;
  const clientNom = document.getElementById("v-client").value.trim();

  if (!camionNom || !siteNom || !produitNom || !chantierNom || !tonnage || !datetime || !clientNom) {
    toast("Merci de compléter tous les champs."); return;
  }

  toast("Enregistrement…");

  // Résolution / création des référentiels (idempotent par nom)
  const camion = await resolveOrCreate("camions", "immatriculation", camionNom, {});
  const site = await resolveOrCreate("sites_production", "nom", siteNom, {});
  const produit = await resolveOrCreate("produits", "taille", produitNom, { site_id: site.id });
  const client = await resolveOrCreate("clients", "nom", clientNom, {});
  const chantier = await resolveOrCreate("chantiers", "nom", chantierNom, { client_id: client.id });

  // Contrôle de doublon
  const { data: dup } = await sb.from("voyages")
    .select("id").eq("camion_id", camion.id).eq("date_chargement", new Date(datetime).toISOString())
    .eq("tonnage_net_kg", tonnage).maybeSingle();
  if (dup) { toast("Un voyage identique existe déjà pour ce camion à cette date."); return; }

  // Trajet : existe-t-il déjà ? sinon, grille progressive
  let { data: trajet } = await sb.from("trajets")
    .select("*").eq("site_id", site.id).eq("chantier_id", chantier.id).eq("produit_id", produit.id).maybeSingle();

  const contexte = { camion, site, produit, client, chantier, tonnage, datetime };

  if (!trajet) {
    openTrajetModal(contexte);
    return;
  }

  await finalizeDepart(contexte, trajet);
}

async function resolveOrCreate(table, field, value, extra) {
  const { data: existing } = await sb.from(table).select("*").ilike(field, value).limit(1);
  if (existing && existing.length) return existing[0];
  const { data, error } = await sb.from(table).insert({ [field]: value, cree_par: CURRENT_USER.id, ...extra }).select().single();
  if (error) { toast("Erreur : " + error.message); throw error; }
  return data;
}

function openTrajetModal(contexte) {
  const content = document.getElementById("trajet-form-content");
  content.innerHTML = `
    <p class="hint">${esc(contexte.site.nom)} → ${esc(contexte.chantier.nom)} · ${esc(contexte.produit.taille)}</p>
    <div class="form-grid">
      <div class="field"><label>Prix de vente au client (F/tonne)</label><input class="control" id="t-vente" type="number"></div>
      <div class="field"><label>Prix payé au transporteur (F/tonne)</label><input class="control" id="t-transp" type="number"></div>
      <div class="field"><label>Dotation gasoil (litres/voyage)</label><input class="control" id="t-dotation" type="number" placeholder="indicatif"></div>
      <div class="field"><label>Péage (F/voyage)</label><input class="control" id="t-peage" type="number" value="0"></div>
      <div class="field"><label>Restauration chauffeur (F/voyage)</label><input class="control" id="t-repas" type="number" value="0"></div>
    </div>
    <div class="actions">
      <button class="btn" id="t-submit">Enregistrer et créer le voyage</button>
      <button class="btn ghost" id="t-skip">Enregistrer le voyage sans prix</button>
    </div>
  `;
  document.getElementById("t-skip").addEventListener("click", async () => {
    await finalizeDepart(contexte, null);
    closeModal("modal-trajet");
  });
  document.getElementById("t-submit").addEventListener("click", async () => {
    const vente = parseFloat(document.getElementById("t-vente").value);
    const transp = parseFloat(document.getElementById("t-transp").value);
    if (!vente || !transp) { toast("Prix de vente et prix transporteur requis."); return; }
    const { data: trajet, error } = await sb.from("trajets").insert({
      site_id: contexte.site.id, chantier_id: contexte.chantier.id, produit_id: contexte.produit.id,
      prix_vente_tonne: vente, prix_transporteur_tonne: transp,
      dotation_gasoil_litres: parseFloat(document.getElementById("t-dotation").value) || 0,
      peage_voyage: parseFloat(document.getElementById("t-peage").value) || 0,
      restauration_voyage: parseFloat(document.getElementById("t-repas").value) || 0,
      cree_par: CURRENT_USER.id
    }).select().single();
    if (error) { toast("Erreur : " + error.message); return; }
    await finalizeDepart(contexte, trajet);
    closeModal("modal-trajet");
  });
  openModal("modal-trajet");
}

async function finalizeDepart(contexte, trajet) {
  // Trouver ou créer la ligne de BC ouverte pour ce client + produit
  const { data: bcOuverts } = await sb.from("bons_commande")
    .select("*, lignes_bc(*)").eq("client_id", contexte.client.id).neq("statut", "cloture");

  let ligneCible = null, bcCible = null;
  for (const bc of (bcOuverts || [])) {
    const ligne = (bc.lignes_bc || []).find(l => l.produit_id === contexte.produit.id && l.statut !== "soldee");
    if (ligne) { ligneCible = ligne; bcCible = bc; break; }
  }

  if (!ligneCible) {
    toast("Aucun BC ouvert pour ce client/produit — créez d'abord un BC.");
    openBcModal({ client: contexte.client, produitPrefill: contexte.produit.taille });
    return;
  }

  const restant = Number(ligneCible.quantite_commandee_kg) - await sommeLivree(ligneCible.id);

  if (contexte.tonnage > restant && restant > 0) {
    openDepassementModal(contexte, trajet, ligneCible, bcCible, restant);
    return;
  }

  await creerVoyage(contexte, trajet, ligneCible);
  if (contexte.tonnage >= restant) await marquerLigneSoldee(ligneCible.id);
  closeModal("modal-voyage");
  toast("Départ enregistré. Le voyage passe en attente de livraison.");
  goScreen(CURRENT_SCREEN);
}

async function sommeLivree(ligneId) {
  const { data } = await sb.from("voyages").select("tonnage_net_kg").eq("ligne_bc_id", ligneId);
  return (data || []).reduce((s, v) => s + Number(v.tonnage_net_kg), 0);
}

async function marquerLigneSoldee(ligneId) {
  await sb.from("lignes_bc").update({ statut: "soldee" }).eq("id", ligneId);
}

function openDepassementModal(contexte, trajet, ligne, bc, restant) {
  const surplus = contexte.tonnage - restant;
  const content = document.getElementById("depassement-content");
  content.innerHTML = `
    <div class="alert-box">
      <span>⚠</span>
      <span>Ce voyage dépasse le reste de la ligne <b>${esc(ligne.produits?.taille || "")}</b> de <b>${fmt(surplus / 1000, 2)} t</b>. Le surplus sera placé sur une nouvelle ligne — les autres lignes de ce BC ne sont pas affectées.</span>
    </div>
    <div class="split">
      <div class="split-card">
        <div class="tag">BC d'origine</div>
        <div style="font-family:var(--f-mono);font-weight:700">${esc(bc.numero)}</div>
        <div style="font-size:13px;margin-top:4px">reçoit <b>${fmt(restant / 1000, 2)} t</b> → soldée</div>
      </div>
      <div class="split-card new">
        <div class="tag">Nouveau BC proposé</div>
        <div style="font-family:var(--f-mono);font-weight:700">${esc(bc.numero)}-B</div>
        <div style="font-size:13px;margin-top:4px">reçoit <b>${fmt(surplus / 1000, 2)} t</b> → à confirmer</div>
      </div>
    </div>
    <div class="actions">
      <button class="btn" id="dep-confirm">Confirmer et enregistrer le voyage</button>
      <button class="btn ghost" id="dep-cancel">Annuler</button>
    </div>
  `;
  document.getElementById("dep-cancel").addEventListener("click", () => closeModal("modal-depassement"));
  document.getElementById("dep-confirm").addEventListener("click", async () => {
    // Créer le nouveau BC + ligne pour le surplus
    const { data: nouveauBc } = await sb.from("bons_commande").insert({
      numero: bc.numero + "-B", client_id: bc.client_id,
      date_debut: bc.date_debut, date_fin: bc.date_fin,
      statut: "ouvert", issu_depassement_de: bc.id, cree_par: CURRENT_USER.id
    }).select().single();
    const { data: nouvelleLigne } = await sb.from("lignes_bc").insert({
      bc_id: nouveauBc.id, produit_id: ligne.produit_id,
      quantite_commandee_kg: surplus, statut: "ouverte"
    }).select().single();

    // Le voyage réel est enregistré en totalité mais rattaché à la ligne d'origine ;
    // pour rester simple et fidèle au ticket unique, on l'enregistre sur la ligne
    // d'origine et on solde celle-ci, puis on trace le surplus comme information
    // de rattachement pour le prochain voyage réel sur la nouvelle ligne si besoin.
    await creerVoyage(contexte, trajet, ligne);
    await marquerLigneSoldee(ligne.id);

    closeModal("modal-depassement");
    closeModal("modal-voyage");
    toast(`Voyage enregistré. BC ${nouveauBc.numero} créé pour le reliquat de ${fmt(surplus/1000,2)} t.`);
    goScreen(CURRENT_SCREEN);
  });
  openModal("modal-depassement");
}

async function creerVoyage(contexte, trajet, ligne) {
  const insertData = {
    ligne_bc_id: ligne.id,
    camion_id: contexte.camion.id,
    trajet_id: trajet ? trajet.id : null,
    date_chargement: new Date(contexte.datetime).toISOString(),
    tonnage_net_kg: contexte.tonnage,
    chantier_id: contexte.chantier.id,
    prix_vente_applique: trajet ? trajet.prix_vente_tonne : null,
    prix_transporteur_applique: trajet ? trajet.prix_transporteur_tonne : null,
    peage_applique: trajet ? trajet.peage_voyage : 0,
    restauration_appliquee: trajet ? trajet.restauration_voyage : 0,
    statut: "charge",
    saisi_par: CURRENT_USER.id
  };
  const { data: voyage, error } = await sb.from("voyages").insert(insertData).select().single();
  if (error) { toast("Erreur : " + error.message); throw error; }

  if (voyageState.photoBlob) {
    const url = await uploadPhoto(voyageState.photoBlob, `${voyage.id}/ticket.jpg`);
    if (url) await sb.from("voyages").update({ photo_ticket_url: url, photo_ticket_statut: "synchronisee" }).eq("id", voyage.id);
  }
  return voyage;
}

// ============================================================
// CONFIRMER LIVRAISON
// ============================================================
let livraisonState = {};

async function openLivraisonModal(voyageId) {
  livraisonState = { voyageId, photoBlob: null };
  const { data: v } = await sb.from("voyages")
    .select("*, camions(immatriculation), chantiers(nom)").eq("id", voyageId).single();

  document.getElementById("livraison-sub").textContent =
    `${v.camions?.immatriculation || ""} · ${v.chantiers?.nom || ""} · ${fmt(v.tonnage_net_kg)} kg`;

  const content = document.getElementById("livraison-form-content");
  content.innerHTML = `
    <div class="form-grid">
      <div class="field"><label>Chargé le</label><input class="control" value="${fmtDateTime(v.date_chargement)}" disabled></div>
      <div class="field"><label>Tonnage net</label><input class="control" value="${fmt(v.tonnage_net_kg)} kg" disabled></div>
      <div class="field span-all">
        <label>Bon de livraison signé</label>
        ${photoSlotHTML("l-photo", "Photographier le bon signé")}
      </div>
      <div class="field">
        <label>Nom du réceptionnaire</label>
        <input class="control" id="l-receptionnaire" placeholder="Tel qu'il a signé">
      </div>
      <div class="field">
        <label>Date et heure de livraison</label>
        <input class="control" id="l-datetime" type="datetime-local">
      </div>
    </div>
    <div class="actions">
      <button class="btn" id="l-submit">Confirmer la livraison</button>
      <button class="btn ghost" id="l-cancel">Annuler</button>
    </div>
  `;
  document.getElementById("l-datetime").value = new Date().toISOString().slice(0, 16);
  wirePhotoSlot("l-photo", (blob) => { livraisonState.photoBlob = blob; });

  document.getElementById("l-cancel").addEventListener("click", () => closeModal("modal-livraison"));
  document.getElementById("l-submit").addEventListener("click", async () => {
    const receptionnaire = document.getElementById("l-receptionnaire").value.trim();
    const datetime = document.getElementById("l-datetime").value;
    if (!receptionnaire || !datetime) { toast("Nom du réceptionnaire et date requis."); return; }

    const update = {
      statut: "livre",
      receptionnaire,
      date_livraison: new Date(datetime).toISOString(),
      modifie_par: CURRENT_USER.id,
      modifie_le: new Date().toISOString()
    };
    await sb.from("voyages").update(update).eq("id", voyageId);

    if (livraisonState.photoBlob) {
      const url = await uploadPhoto(livraisonState.photoBlob, `${voyageId}/livraison.jpg`);
      if (url) await sb.from("voyages").update({ photo_livraison_url: url, photo_livraison_statut: "synchronisee" }).eq("id", voyageId);
    }

    closeModal("modal-livraison");
    toast("Livraison confirmée.");
    goScreen(CURRENT_SCREEN);
  });

  openModal("modal-livraison");
}

// ============================================================
// BONS DE COMMANDE
// ============================================================
async function renderBcs() {
  const el = document.getElementById("bcs-content");
  el.innerHTML = `<div class="loading">Chargement…</div>`;

  const { data: bcs } = await sb.from("bons_commande")
    .select("*, clients(nom), lignes_bc(*, produits(taille))")
    .order("cree_le", { ascending: false });

  if (!bcs || bcs.length === 0) { el.innerHTML = `<div class="empty">Aucun bon de commande. Créez-en un.</div>`; return; }

  const rows = await Promise.all(bcs.map(async (bc) => {
    let commande = 0, livre = 0;
    for (const l of bc.lignes_bc || []) {
      commande += Number(l.quantite_commandee_kg);
      livre += await sommeLivree(l.id);
    }
    const pct = commande > 0 ? Math.min(100, (livre / commande) * 100) : 0;
    const soldee = (bc.lignes_bc || []).every(l => l.statut === "soldee");
    const statutAffiche = soldee ? "solde" : (bc.date_fin && new Date(bc.date_fin) < new Date() && !soldee ? "retard" : "encours");
    const produitsListe = (bc.lignes_bc || []).map(l => l.produits?.taille).join(" + ");

    return `
      <div class="row" data-id="${bc.id}">
        <div class="top">
          <div>
            <div class="id">${esc(bc.numero)}</div>
            <div class="sub">${esc(bc.clients?.nom || "")} · ${esc(produitsListe)}</div>
          </div>
          <div class="right">
            <span class="badge ${statutAffiche}">${statutAffiche === "solde" ? "Soldé" : statutAffiche === "retard" ? "En retard" : "En cours"}</span>
            <span class="amt">${fmt(livre / 1000, 1)} / ${fmt(commande / 1000, 1)} t</span>
          </div>
        </div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>`;
  }));

  el.innerHTML = rows.join("");
  el.querySelectorAll(".row").forEach(r => r.addEventListener("click", () => renderBcDetail(r.dataset.id)));
}

async function renderBcDetail(bcId) {
  goScreen(null);
  document.querySelectorAll(".screen").forEach(s => s.hidden = true);
  document.getElementById("s-bc-detail").hidden = false;

  const el = document.getElementById("bc-detail-content");
  el.innerHTML = `<div class="loading">Chargement…</div>`;

  const { data: bc } = await sb.from("bons_commande")
    .select("*, clients(nom), lignes_bc(*, produits(taille))").eq("id", bcId).single();

  const { data: voyages } = await sb.from("voyages")
    .select("*, camions(immatriculation), chantiers(nom), sites_production_via_trajet:trajet_id(*)")
    .in("ligne_bc_id", (bc.lignes_bc || []).map(l => l.id))
    .order("date_chargement", { ascending: false });

  let commande = 0, livre = 0;
  const lignesHtml = await Promise.all((bc.lignes_bc || []).map(async (l) => {
    const liv = await sommeLivree(l.id);
    commande += Number(l.quantite_commandee_kg); livre += liv;
    const pct = Math.min(100, (liv / Number(l.quantite_commandee_kg)) * 100);
    return `
      <div class="ligne-card" style="border:1px solid var(--line);border-radius:9px;padding:13px 14px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span style="font-family:var(--f-mono);font-weight:700">${esc(l.produits?.taille || "")}</span>
          <span class="badge ${l.statut === 'soldee' ? 'solde' : 'encours'}">${l.statut === 'soldee' ? 'Soldée' : 'En cours'}</span>
        </div>
        <div style="font-family:var(--f-mono);font-size:12.5px;color:var(--muted)">${fmt(liv/1000,2)} / ${fmt(l.quantite_commandee_kg/1000,2)} t</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>`;
  }));

  const chantierMap = {};
  (voyages || []).forEach(v => {
    const nom = v.chantiers?.nom || "—";
    chantierMap[nom] = (chantierMap[nom] || 0) + Number(v.tonnage_net_kg);
  });
  const chantiersHtml = Object.entries(chantierMap).map(([nom, kg]) => {
    const pct = livre > 0 ? (kg / livre) * 100 : 0;
    return `
      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:13.5px;margin-bottom:4px">
          <b>${esc(nom)}</b><span style="font-family:var(--f-mono);color:var(--muted)">${fmt(kg/1000,2)} t</span>
        </div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>`;
  }).join("") || `<p class="hint">Aucun voyage livré pour l'instant.</p>`;

  const voyagesRows = (voyages || []).slice(0, 15).map(v => `
    <tr>
      <td>${fmtDate(v.date_chargement)}</td>
      <td>${esc(v.camions?.immatriculation || "")}</td>
      <td>${esc(v.chantiers?.nom || "")}</td>
      <td class="num">${fmt(v.tonnage_net_kg)} kg</td>
      <td><span class="badge ${v.statut}">${v.statut === 'charge' ? 'En route' : v.statut === 'livre' ? 'Livré' : 'Clôturé'}</span></td>
    </tr>`).join("");

  el.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-family:var(--f-mono);font-size:19px;font-weight:700">${esc(bc.numero)}</div>
          <div class="card-foot">${esc(bc.clients?.nom || "")} · ${(bc.lignes_bc||[]).length} ligne(s)</div>
        </div>
        <span class="badge encours">${bc.statut}</span>
      </div>
      <div class="grid" style="margin-top:14px;grid-template-columns:repeat(3,1fr)">
        <div><p class="card-label">Commandé</p><p class="stat" style="font-size:19px">${fmt(commande/1000,2)} t</p></div>
        <div><p class="card-label">Livré</p><p class="stat" style="font-size:19px">${fmt(livre/1000,2)} t</p></div>
        <div><p class="card-label">Échéance</p><p class="stat" style="font-size:15px">${fmtDate(bc.date_fin)}</p></div>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <p class="card-label">Lignes de produit</p>
      ${lignesHtml.join("")}
    </div>

    <div class="card" style="margin-bottom:14px">
      <p class="card-label">Répartition par chantier</p>
      <p class="card-foot" style="margin-bottom:12px">Lecture des voyages réellement effectués — jamais un quota imposé.</p>
      ${chantiersHtml}
    </div>

    <div class="card">
      <p class="card-label">Voyages rattachés</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Camion</th><th>Chantier</th><th class="num">Net</th><th>État</th></tr></thead>
          <tbody>${voyagesRows || '<tr><td colspan="5" style="color:var(--muted)">Aucun voyage.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `;
}

// ---------- Nouveau BC ----------
function openBcModal(prefill = {}) {
  const content = document.getElementById("bc-form-content");
  let lignesCount = 0;
  const lignesData = [];

  function renderLignes() {
    return lignesData.map((l, i) => `
      <div class="form-item" style="border:1px solid var(--line);border-radius:9px;padding:13px 14px;margin-bottom:10px" data-idx="${i}">
        <div style="display:flex;justify-content:space-between;margin-bottom:10px">
          <span style="font-family:var(--f-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">Ligne ${i + 1}</span>
          <button type="button" class="rm-ligne" data-idx="${i}" style="background:none;border:0;color:var(--warn);font-size:17px">×</button>
        </div>
        <div class="form-grid">
          <div class="field"><label>Produit</label><input class="control ligne-produit" data-idx="${i}" placeholder="Ex. 5/15" value="${esc(l.produit || "")}"></div>
          <div class="field"><label>Quantité commandée (t)</label><input class="control ligne-qte" data-idx="${i}" type="number" value="${l.qte || ""}"></div>
        </div>
      </div>`).join("");
  }

  function addLigne(produit = "") {
    lignesData.push({ produit, qte: "" });
    renderAll();
  }

  function renderAll() {
    content.innerHTML = `
      <div class="form-grid">
        <div class="field"><label>Numéro du BC</label><input class="control" id="bc-numero" placeholder="Tel qu'écrit sur le bon"></div>
        <div class="field suggestwrap"><label>Client</label><input class="control" id="bc-client" placeholder="Rechercher un client" value="${esc(prefill.client?.nom || "")}"><div class="suggest" hidden></div></div>
        <div class="field"><label>Début d'exécution</label><input class="control" id="bc-debut" type="date"></div>
        <div class="field"><label>Fin d'exécution</label><input class="control" id="bc-fin" type="date"></div>
      </div>
      <div style="margin-top:16px">
        <label style="display:block;font-family:var(--f-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:10px">Lignes de produit</label>
        <div id="bc-lignes">${renderLignes()}</div>
        <button type="button" class="btn ghost small" id="bc-addligne" style="width:100%">+ Ajouter une ligne de produit</button>
      </div>
      <p class="hint" style="margin-top:14px">Aucun chantier à préciser : chaque voyage indiquera le sien.</p>
      <div class="actions">
        <button class="btn" id="bc-submit">Créer le BC</button>
        <button class="btn ghost" id="bc-cancel">Annuler</button>
      </div>
    `;
    document.getElementById("bc-addligne").addEventListener("click", () => addLigne());
    content.querySelectorAll(".rm-ligne").forEach(b => b.addEventListener("click", () => {
      lignesData.splice(Number(b.dataset.idx), 1); renderAll();
    }));
    content.querySelectorAll(".ligne-produit").forEach(i => i.addEventListener("input", () => {
      lignesData[i.dataset.idx].produit = i.value;
    }));
    content.querySelectorAll(".ligne-qte").forEach(i => i.addEventListener("input", () => {
      lignesData[i.dataset.idx].qte = i.value;
    }));
    wireSuggest("bc-client", "clients", "nom", { onPick: (c) => { selectedClient = c; } });
    document.getElementById("bc-cancel").addEventListener("click", () => closeModal("modal-bc"));
    document.getElementById("bc-submit").addEventListener("click", submitBc);
  }

  let selectedClient = prefill.client || null;

  async function submitBc() {
    const numero = document.getElementById("bc-numero").value.trim();
    const clientNom = document.getElementById("bc-client").value.trim();
    const debut = document.getElementById("bc-debut").value;
    const fin = document.getElementById("bc-fin").value;

    if (!numero || !clientNom || lignesData.length === 0) {
      toast("Numéro, client et au moins une ligne sont requis."); return;
    }
    const validLignes = lignesData.filter(l => l.produit && l.qte);
    if (validLignes.length === 0) { toast("Complétez au moins une ligne de produit."); return; }

    const client = selectedClient || await resolveOrCreate("clients", "nom", clientNom, {});

    const { data: existant } = await sb.from("bons_commande").select("id").eq("client_id", client.id).eq("numero", numero).maybeSingle();
    if (existant) { toast("Ce numéro de BC existe déjà pour ce client."); return; }

    const { data: bc, error } = await sb.from("bons_commande").insert({
      numero, client_id: client.id, date_debut: debut || null, date_fin: fin || null,
      statut: "ouvert", cree_par: CURRENT_USER.id
    }).select().single();
    if (error) { toast("Erreur : " + error.message); return; }

    for (const l of validLignes) {
      const produit = await resolveOrCreate("produits", "taille", l.produit, {});
      await sb.from("lignes_bc").insert({
        bc_id: bc.id, produit_id: produit.id,
        quantite_commandee_kg: parseFloat(l.qte) * 1000, statut: "ouverte"
      });
    }

    closeModal("modal-bc");
    toast("Bon de commande créé.");
    if (CURRENT_SCREEN === "bcs") renderBcs();
  }

  if (prefill.produitPrefill) addLigne(prefill.produitPrefill); else addLigne();
  openModal("modal-bc");
}

// ============================================================
// TRANSPORTEURS
// ============================================================
async function renderTransporteurs() {
  const el = document.getElementById("transporteurs-content");
  el.innerHTML = `<div class="loading">Chargement…</div>`;
  const { data: transporteurs } = await sb.from("transporteurs").select("*, camions(*)").order("nom");
  if (!transporteurs || transporteurs.length === 0) { el.innerHTML = `<div class="empty">Aucun transporteur.</div>`; return; }

  el.innerHTML = transporteurs.map(t => `
    <div class="row" data-id="${t.id}">
      <div class="top">
        <div>
          <div class="id">${esc(t.nom)}</div>
          <div class="sub">${(t.camions || []).length} camion(s)</div>
        </div>
        <div class="right"><span class="badge encours">Voir décompte</span></div>
      </div>
    </div>`).join("");

  el.querySelectorAll(".row").forEach(r => r.addEventListener("click", () => renderTransporteurDetail(r.dataset.id)));
}

function openTransporteurModal() {
  const content = document.getElementById("transporteur-form-content");
  content.innerHTML = `
    <div class="form-grid">
      <div class="field"><label>Nom</label><input class="control" id="tr-nom"></div>
      <div class="field"><label>Téléphone</label><input class="control" id="tr-tel"></div>
    </div>
    <div class="actions">
      <button class="btn" id="tr-submit">Créer</button>
      <button class="btn ghost" id="tr-cancel">Annuler</button>
    </div>
  `;
  document.getElementById("tr-cancel").addEventListener("click", () => closeModal("modal-transporteur"));
  document.getElementById("tr-submit").addEventListener("click", async () => {
    const nom = document.getElementById("tr-nom").value.trim();
    if (!nom) { toast("Le nom est requis."); return; }
    await sb.from("transporteurs").insert({ nom, telephone: document.getElementById("tr-tel").value.trim(), cree_par: CURRENT_USER.id });
    closeModal("modal-transporteur");
    toast("Transporteur créé.");
    renderTransporteurs();
  });
  openModal("modal-transporteur");
}

// ---------- Fiche transporteur = décompte ----------
async function renderTransporteurDetail(transporteurId) {
  document.querySelectorAll(".screen").forEach(s => s.hidden = true);
  document.getElementById("s-transporteur-detail").hidden = false;

  const el = document.getElementById("transporteur-detail-content");
  el.innerHTML = `<div class="loading">Chargement…</div>`;

  const { data: transporteur } = await sb.from("transporteurs").select("*, camions(id, immatriculation)").eq("id", transporteurId).single();
  const camionIds = (transporteur.camions || []).map(c => c.id);

  const { data: voyages } = camionIds.length
    ? await sb.from("voyages").select("*, camions(immatriculation), chantiers(nom)").in("camion_id", camionIds).eq("statut", "livre").order("date_chargement", { ascending: false })
    : { data: [] };

  const { data: mouvements } = await sb.from("mouvements_transporteur").select("*").eq("transporteur_id", transporteurId).order("date_mouvement", { ascending: false });

  let duTransp = 0, gasoilDecaisse = 0, peagesDecaisse = 0, repasDecaisse = 0;
  (voyages || []).forEach(v => {
    if (v.prix_transporteur_applique) duTransp += (Number(v.tonnage_net_kg) / 1000) * Number(v.prix_transporteur_applique);
    peagesDecaisse += Number(v.peage_applique || 0);
    repasDecaisse += Number(v.restauration_appliquee || 0);
  });

  const { data: pleins } = camionIds.length
    ? await sb.from("pleins_gasoil").select("*").in("camion_id", camionIds)
    : { data: [] };
  gasoilDecaisse = (pleins || []).reduce((s, p) => s + Number(p.montant), 0);

  const avances = (mouvements || []).filter(m => m.type === "avance_especes").reduce((s, m) => s + Number(m.montant), 0);
  const reparations = (mouvements || []).filter(m => m.type === "reparation_decaissee").reduce((s, m) => s + Number(m.montant), 0);
  const paiements = (mouvements || []).filter(m => m.type === "paiement").reduce((s, m) => s + Number(m.montant), 0);

  const reste = duTransp - avances - gasoilDecaisse - peagesDecaisse - repasDecaisse - reparations - paiements;
  const nbVoyages = (voyages || []).length;
  const tonnageTotal = (voyages || []).reduce((s, v) => s + Number(v.tonnage_net_kg), 0) / 1000;

  const shareText = `${transporteur.nom} — Décompte
${nbVoyages} voyages · ${fmt(tonnageTotal, 2)} t
Dû : ${fmt(duTransp)} F
Avances : ${fmt(avances)} F
Gasoil : ${fmt(gasoilDecaisse)} F
Péages : ${fmt(peagesDecaisse)} F
Restauration : ${fmt(repasDecaisse)} F
${reparations > 0 ? "Réparations : " + fmt(reparations) + " F\n" : ""}${reste < 0 ? "CRÉANCE : " + fmt(Math.abs(reste)) : "RESTE : " + fmt(reste)} F`;

  el.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <div>
          <p class="card-label">Décompte transporteur</p>
          <div style="font-family:var(--f-display);font-size:20px;font-weight:700">${esc(transporteur.nom)}</div>
        </div>
        <button class="btn small" id="btn-add-mouvement">+ Mouvement</button>
      </div>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Camion</th><th>Chantier</th><th class="num">Net</th><th class="num">Montant</th></tr></thead>
          <tbody>
            ${(voyages || []).slice(0, 20).map(v => `
              <tr>
                <td>${fmtDate(v.date_chargement)}</td>
                <td>${esc(v.camions?.immatriculation || "")}</td>
                <td>${esc(v.chantiers?.nom || "")}</td>
                <td class="num">${fmt(v.tonnage_net_kg)} kg</td>
                <td class="num">${v.prix_transporteur_applique ? fmt((v.tonnage_net_kg/1000) * v.prix_transporteur_applique) : "—"}</td>
              </tr>`).join("") || '<tr><td colspan="5" style="color:var(--muted)">Aucun voyage livré.</td></tr>'}
          </tbody>
        </table>
      </div>

      <div style="margin-top:16px">
        <div class="recap-line"><span>Transport dû · ${fmt(tonnageTotal, 2)} t</span><span>${fmt(duTransp)} F</span></div>
        <div class="recap-line minus"><span>Avances versées</span><span>− ${fmt(avances)} F</span></div>
        <div class="recap-line minus"><span>Gasoil décaissé</span><span>− ${fmt(gasoilDecaisse)} F</span></div>
        <div class="recap-line minus"><span>Péages décaissés</span><span>− ${fmt(peagesDecaisse)} F</span></div>
        <div class="recap-line minus"><span>Restauration décaissée</span><span>− ${fmt(repasDecaisse)} F</span></div>
        ${reparations > 0 ? `<div class="recap-line minus"><span>Réparations décaissées</span><span>− ${fmt(reparations)} F</span></div>` : ""}
        ${paiements > 0 ? `<div class="recap-line minus"><span>Déjà payé</span><span>− ${fmt(paiements)} F</span></div>` : ""}
      </div>
      <div class="recap-solde">
        <span class="lbl">${reste < 0 ? "Créance à récupérer" : "Reste à payer"}</span>
        <span class="val" style="color:${reste < 0 ? 'var(--ok)' : 'var(--ink)'}">${fmt(Math.abs(reste))} F</span>
      </div>
      <div class="share">${esc(shareText)}</div>
      <div class="actions">
        <button class="btn small" id="btn-whatsapp">Partager sur WhatsApp</button>
        <button class="btn ghost small" id="btn-copy">Copier le résumé</button>
      </div>
    </div>
  `;

  document.getElementById("btn-whatsapp").addEventListener("click", () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(shareText)}`, "_blank");
  });
  document.getElementById("btn-copy").addEventListener("click", () => {
    navigator.clipboard.writeText(shareText);
    toast("Résumé copié.");
  });
  document.getElementById("btn-add-mouvement").addEventListener("click", () => openMouvementModal(transporteurId));
}

function openMouvementModal(transporteurId) {
  const content = document.getElementById("mouvement-form-content");
  content.innerHTML = `
    <div class="form-grid">
      <div class="field">
        <label>Type</label>
        <select class="control" id="m-type">
          <option value="avance_especes">Avance en espèces</option>
          <option value="peage_decaisse">Péage décaissé</option>
          <option value="reparation_decaissee">Réparation / dépannage</option>
          <option value="regularisation_exceptionnelle">Régularisation exceptionnelle</option>
          <option value="paiement">Paiement effectué</option>
        </select>
      </div>
      <div class="field"><label>Montant (F)</label><input class="control" id="m-montant" type="number"></div>
      <div class="field"><label>Date</label><input class="control" id="m-date" type="date"></div>
      <div class="field span-all"><label>Motif</label><input class="control" id="m-motif" placeholder="Facultatif"></div>
    </div>
    <div class="actions">
      <button class="btn" id="m-submit">Enregistrer</button>
      <button class="btn ghost" id="m-cancel">Annuler</button>
    </div>
  `;
  document.getElementById("m-date").value = new Date().toISOString().slice(0, 10);
  document.getElementById("m-cancel").addEventListener("click", () => closeModal("modal-mouvement"));
  document.getElementById("m-submit").addEventListener("click", async () => {
    const montant = parseFloat(document.getElementById("m-montant").value);
    if (!montant) { toast("Montant requis."); return; }
    await sb.from("mouvements_transporteur").insert({
      transporteur_id: transporteurId,
      type: document.getElementById("m-type").value,
      montant, date_mouvement: document.getElementById("m-date").value,
      motif: document.getElementById("m-motif").value.trim(),
      saisi_par: CURRENT_USER.id
    });
    closeModal("modal-mouvement");
    toast("Mouvement enregistré.");
    renderTransporteurDetail(transporteurId);
  });
  openModal("modal-mouvement");
}

// ---------- démarrage ----------
boot();
