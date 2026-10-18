/*
 * Profile Presets v4 - Vencord custom userplugin
 * Authors: twitch.tv/yonaaw_ and twitch.tv/Chihiroqt
 * Save as src/userplugins/profilePresets/index.ts
 *
 * The preview is an approximation, not Discord's full animation renderer.
 * Frames currently have no verified write route and are preview-only.
 * Discord can reject changes because of permissions, ownership or changed APIs.
 */
import * as DataStore from "@api/DataStore";
import definePlugin from "@utils/types";
import { RestAPI, showToast, Toasts, UserStore } from "@webpack/common";

const PRESET_KEY = "ProfilePresets_v2"; // Deliberately reuse older presets.
const CONFIG_KEY = "ProfilePresets_v4_config";
const UNDO_KEY = "ProfilePresets_v4_undo";
const BUTTON_ID = "vc-profile-presets-button";
const MODAL_ID = "vc-profile-presets-modal";

type Field = "avatar" | "banner" | "decoration" | "nameplate" | "theme" | "effect" | "displayName" | "frame";
type FieldSelection = Record<Field, boolean>;
const FIELDS: Array<{ key: Field; label: string }> = [
    { key: "avatar", label: "Avatar" },
    { key: "banner", label: "Banner" },
    { key: "decoration", label: "Decoration" },
    { key: "nameplate", label: "Nameplate" },
    { key: "theme", label: "Theme / colors" },
    { key: "effect", label: "Profile effect" },
    { key: "displayName", label: "Display-name style" },
    { key: "frame", label: "Profile frame (preview only)" }
];

interface ProfilePreset {
    id: string;
    name: string;
    createdAt: number;
    avatar: string | null;
    banner: string | null;
    accentColor: number | null;
    themeColors: [number, number] | null;
    avatarDecorationSkuId: string | null;
    avatarDecorationAsset?: string | null;
    nameplateSkuId: string | null;
    nameplateLabel?: string | null;
    displayNameFontId: number | null;
    displayNameEffectId: number | null;
    displayNameColors: number[] | null;
    profileEffectId: string | null;
    profileFrameSkuId: string | null;
    collectibles: Record<string, any> | null;
    folder?: string;
    tags?: string[];
    favorite?: boolean;
    inRotation?: boolean;
    customThumbnail?: string | null;
    displayName?: string | null;
    // Which fields were actually present in the response, including an explicit null.
    capturedFields?: Partial<Record<Field, boolean>>;
}

interface Config {
    fields: FieldSelection;
    rotationEnabled: boolean;
    rotationPeriod: "daily" | "weekly";
    lastRotationAt: number;
    lastRotationId: string | null;
    filter: string;
    folder: string;
}
interface UndoEntry { preset: ProfilePreset; fields: FieldSelection; timestamp: number; }
interface ApplyReport { accepted: string[]; skipped: string[]; errors: string[]; }

const ALL_FIELDS: FieldSelection = {
    avatar: true, banner: true, decoration: true, nameplate: true,
    theme: true, effect: true, displayName: true, frame: false
};
const defaultConfig = (): Config => ({
    fields: { ...ALL_FIELDS }, rotationEnabled: false, rotationPeriod: "daily",
    lastRotationAt: 0, lastRotationId: null, filter: "", folder: "All folders"
});
let busy = false;
let refreshTimer: number | null = null;
let rotationTimer: number | null = null;
let observer: MutationObserver | null = null;
let modalGeneration = 0;

const asString = (v: any): string | null => typeof v === "string" && v.trim() ? v : null;
const idOf = (v: any): string | null => v == null ? null : asString(String(v?.sku_id ?? v?.skuId ?? v?.id ?? ""));
const take = (...values: any[]) => values.find(v => v !== undefined && v !== null) ?? null;
const colorHex = (v: any) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffff
    ? `#${v.toString(16).padStart(6, "0")}` : null;
const safeImg = (v: any): string | null => {
    if (typeof v !== "string") return null;
    return (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(v) || /^https:\/\/cdn\.discordapp\.com\//i.test(v)) ? v : null;
};
const parseTags = (v: string) => [...new Set(v.split(",").map(t => t.trim()).filter(Boolean))].slice(0, 12);
const errMessage = (e: any) => String(e?.body?.message ?? e?.message ?? e?.status ?? e ?? "Unknown error").slice(0, 170);
const toast = (message: string, type = Toasts.Type.MESSAGE) => showToast(message.slice(0, 250), type);

function normalizePreset(raw: any): ProfilePreset {
    return {
        ...raw,
        id: asString(raw?.id) ?? crypto.randomUUID(),
        name: asString(raw?.name)?.slice(0, 80) ?? "Untitled",
        createdAt: Number.isFinite(raw?.createdAt) ? raw.createdAt : Date.now(),
        avatar: safeImg(raw?.avatar), banner: safeImg(raw?.banner),
        accentColor: typeof raw?.accentColor === "number" ? raw.accentColor : null,
        themeColors: Array.isArray(raw?.themeColors) && raw.themeColors.length === 2
            ? [Number(raw.themeColors[0]), Number(raw.themeColors[1])] : null,
        avatarDecorationSkuId: asString(raw?.avatarDecorationSkuId ?? raw?.decoration?.skuId),
        avatarDecorationAsset: asString(raw?.avatarDecorationAsset ?? raw?.decoration?.asset),
        nameplateSkuId: asString(raw?.nameplateSkuId),
        nameplateLabel: asString(raw?.nameplateLabel),
        displayNameFontId: typeof raw?.displayNameFontId === "number" ? raw.displayNameFontId : null,
        displayNameEffectId: typeof raw?.displayNameEffectId === "number" ? raw.displayNameEffectId : null,
        displayNameColors: Array.isArray(raw?.displayNameColors) ? raw.displayNameColors.filter((n: any) => typeof n === "number").slice(0, 5) : null,
        profileEffectId: asString(raw?.profileEffectId),
        profileFrameSkuId: asString(raw?.profileFrameSkuId),
        collectibles: raw?.collectibles && typeof raw.collectibles === "object" && !Array.isArray(raw.collectibles) ? raw.collectibles : null,
        folder: asString(raw?.folder)?.slice(0, 40) ?? "Unsorted",
        tags: Array.isArray(raw?.tags) ? raw.tags.filter((t: any) => typeof t === "string").slice(0, 12) : [],
        favorite: Boolean(raw?.favorite), inRotation: Boolean(raw?.inRotation),
        customThumbnail: safeImg(raw?.customThumbnail),
        displayName: asString(raw?.displayName),
        capturedFields: raw?.capturedFields && typeof raw.capturedFields === "object" ? raw.capturedFields : {}
    };
}
async function readPresets(): Promise<ProfilePreset[]> {
    const stored = await DataStore.get(PRESET_KEY);
    return Array.isArray(stored) ? stored.filter(p => p && typeof p === "object").map(normalizePreset) : [];
}
async function writePresets(p: ProfilePreset[]) { await DataStore.set(PRESET_KEY, p); }
async function readConfig(): Promise<Config> {
    const raw: any = await DataStore.get(CONFIG_KEY);
    const cfg = defaultConfig();
    if (!raw || typeof raw !== "object") return cfg;
    return {
        ...cfg, ...raw,
        fields: { ...ALL_FIELDS, ...raw.fields, frame: false },
        rotationEnabled: raw.rotationEnabled === true,
        rotationPeriod: raw.rotationPeriod === "weekly" ? "weekly" : "daily",
        lastRotationAt: Number.isFinite(raw.lastRotationAt) ? raw.lastRotationAt : 0,
        lastRotationId: asString(raw.lastRotationId),
        filter: asString(raw.filter) ?? "",
        folder: asString(raw.folder) ?? "All folders"
    };
}
async function writeConfig(cfg: Config) { await DataStore.set(CONFIG_KEY, cfg); }
async function readUndo(): Promise<UndoEntry | null> {
    const v: any = await DataStore.get(UNDO_KEY);
    if (!v?.preset || !v?.fields) return null;
    return { preset: normalizePreset(v.preset), fields: { ...ALL_FIELDS, ...v.fields, frame: false }, timestamp: Number(v.timestamp) || 0 };
}

function userCdn(kind: "avatars" | "banners", id: string, hash: string) {
    return `https://cdn.discordapp.com/${kind}/${id}/${hash}.${hash.startsWith("a_") ? "gif" : "png"}?size=1024`;
}
async function urlData(url: string): Promise<string> {
    const result = await fetch(url);
    if (!result.ok) throw new Error(`Image download failed (${result.status})`);
    const blob = await result.blob();
    return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}
async function readProfile(): Promise<ProfilePreset> {
    const cached: any = UserStore.getCurrentUser();
    if (!cached?.id) throw new Error("Discord account not loaded");
    const [accountResponse, profileResponse] = await Promise.all([
        RestAPI.get({ url: "/users/@me" }),
        RestAPI.get({ url: `/users/${cached.id}/profile`, query: { with_mutual_guilds: false, with_mutual_friends_count: false } })
    ]);
    const acct: any = accountResponse?.body ?? cached;
    const data: any = profileResponse?.body ?? {};
    const profile: any = data.user_profile ?? {};
    const user: any = data.user ?? acct;
    const avatarHash = take(acct.avatar, user.avatar, cached.avatar);
    const bannerHash = take(acct.banner, user.banner, profile.banner, cached.banner);
    const [avatar, banner] = await Promise.all([
        avatarHash ? urlData(userCdn("avatars", cached.id, avatarHash)) : Promise.resolve(null),
        bannerHash ? urlData(userCdn("banners", cached.id, bannerHash)) : Promise.resolve(null)
    ]);
    const decoration: any = take(acct.avatar_decoration_data, acct.avatarDecorationData, user.avatar_decoration_data, cached.avatarDecorationData);
    const collectibles: any = take(acct.collectibles, user.collectibles, cached.collectibles);
    const plate: any = collectibles?.nameplate;
    const frame: any = collectibles?.profile_frame ?? collectibles?.profileFrame ?? profile?.profile_frame;
    const nameStyle: any = take(acct.display_name_styles, acct.displayNameStyles, user.display_name_styles, user.displayNameStyles);
    const effect: any = take(profile.profile_effect, profile.profileEffect);
    const theme = take(profile.theme_colors, profile.themeColors);
    return {
        id: crypto.randomUUID(), name: "Snapshot", createdAt: Date.now(),
        avatar, banner,
        accentColor: take(profile.accent_color, profile.accentColor, acct.accent_color, acct.accentColor),
        themeColors: Array.isArray(theme) && theme.length === 2 ? [Number(theme[0]), Number(theme[1])] : null,
        avatarDecorationSkuId: idOf(decoration),
        avatarDecorationAsset: asString(decoration?.asset),
        nameplateSkuId: idOf(plate),
        nameplateLabel: asString(plate?.label),
        displayNameFontId: take(nameStyle?.font_id, nameStyle?.fontId),
        displayNameEffectId: take(nameStyle?.effect_id, nameStyle?.effectId),
        displayNameColors: Array.isArray(nameStyle?.colors) ? nameStyle.colors.map(Number) : null,
        profileEffectId: asString(String(take(effect?.id, profile.profile_effect_id, profile.profileEffectId) ?? "")),
        profileFrameSkuId: idOf(frame),
        collectibles: collectibles ? structuredClone(collectibles) : null,
        displayName: asString(take(acct.global_name, acct.globalName, cached.globalName)),
        folder: "Unsorted", tags: [], favorite: false, inRotation: false, customThumbnail: null,
        capturedFields: {
            avatar: "avatar" in acct,
            banner: "banner" in acct || "banner" in user || "banner" in profile,
            decoration: "avatar_decoration_data" in acct || "avatarDecorationData" in acct,
            nameplate: "collectibles" in acct,
            theme: "theme_colors" in profile || "themeColors" in profile || "accent_color" in profile,
            effect: "profile_effect" in profile || "profileEffect" in profile,
            displayName: "display_name_styles" in acct || "displayNameStyles" in acct,
            frame: false
        }
    };
}

function available(p: ProfilePreset, key: Field): boolean {
    switch (key) {
        case "avatar": return Boolean(p.avatar);
        case "banner": return Boolean(p.banner);
        case "decoration": return Boolean(p.avatarDecorationSkuId);
        case "nameplate": return Boolean(p.nameplateSkuId);
        case "theme": return p.accentColor !== null || Boolean(p.themeColors);
        case "effect": return Boolean(p.profileEffectId);
        case "displayName": return p.displayNameFontId !== null || p.displayNameEffectId !== null || Boolean(p.displayNameColors?.length);
        case "frame": return Boolean(p.profileFrameSkuId);
    }
}
async function applyFields(p: ProfilePreset, selection: FieldSelection): Promise<ApplyReport> {
    const report: ApplyReport = { accepted: [], skipped: [], errors: [] };
    let rateLimited = false;
    const run = async (key: Field, label: string, url: string, body: Record<string, unknown>) => {
        if (!selection[key]) return;
        try {
            await RestAPI.patch({ url, body });
            report.accepted.push(label);
        } catch (e) {
            report.errors.push(`${label}: ${errMessage(e)}`);
            console.error(`[ProfilePresets] ${label} rejected`, e);
            if ((e as any)?.status === 429) {
                report.errors.push("Rate limited by Discord; remaining fields not attempted");
                rateLimited = true;
            }
        }
    };
    for (const field of FIELDS) {
        if (rateLimited) break;
        if (!selection[field.key]) continue;
        if (field.key === "frame") { report.skipped.push("Frame: no verified restore API"); continue; }
        if (!available(p, field.key) && !p.capturedFields?.[field.key]) { report.skipped.push(`${field.label}: not captured`); continue; }
        switch (field.key) {
            case "avatar": await run(field.key, field.label, "/users/@me", { avatar: p.avatar }); break;
            case "banner": await run(field.key, field.label, "/users/@me", { banner: p.banner }); break;
            case "decoration": await run(field.key, field.label, "/users/@me", { avatar_decoration_sku_id: p.avatarDecorationSkuId }); break;
            case "nameplate": await run(field.key, field.label, "/users/@me", { nameplate_sku_id: p.nameplateSkuId }); break;
            case "displayName": await run(field.key, field.label, "/users/@me", {
                display_name_font_id: p.displayNameFontId, display_name_effect_id: p.displayNameEffectId,
                display_name_colors: p.displayNameColors
            }); break;
            case "theme": await run(field.key, field.label, "/users/@me/profile", {
                ...(p.accentColor !== null || p.capturedFields?.theme ? { accent_color: p.accentColor } : {}),
                ...(p.themeColors || p.capturedFields?.theme ? { theme_colors: p.themeColors } : {})
            }); break;
            case "effect": await run(field.key, field.label, "/users/@me/profile", { profile_effect_id: p.profileEffectId }); break;
        }
    }
    return report;
}
function reportText(r: ApplyReport) {
    const parts = [`Discord accepted ${r.accepted.length} update request(s). This does not guarantee that the visuals changed.`];
    if (r.skipped.length) parts.push(`Skipped: ${r.skipped.join("; ")}.`);
    if (r.errors.length) parts.push(`Rejected: ${r.errors.join("; ")}.`);
    return parts.join(" ");
}
async function applyWithUndo(p: ProfilePreset, fields: FieldSelection): Promise<ApplyReport> {
    if (busy) throw new Error("Another profile operation is already running");
    busy = true;
    try {
        // Preserve exact pre-switch snapshot so the user can undo partial switches.
        const previous = await readProfile();
        await DataStore.set(UNDO_KEY, { preset: previous, fields: { ...fields }, timestamp: Date.now() } as UndoEntry);
        return await applyFields(p, fields);
    } finally { busy = false; }
}
async function undoSwitch(): Promise<ApplyReport> {
    if (busy) throw new Error("Another profile operation is already running");
    const previous = await readUndo();
    if (!previous) throw new Error("Nothing available to undo");
    busy = true;
    try {
        const report = await applyFields(previous.preset, previous.fields);
        if (!report.errors.length) await DataStore.del(UNDO_KEY);
        return report;
    } finally { busy = false; }
}

function style(el: HTMLElement, values: Partial<CSSStyleDeclaration>) { Object.assign(el.style, values); return el; }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e;
}
function btn(label: string, handler: () => void, variant: "primary" | "secondary" | "danger" = "secondary") {
    const b = el("button", `pp-btn pp-${variant}`, label); b.type = "button"; b.onclick = handler; return b;
}
function img(src: string, klass: string) { const i = el("img", klass); i.src = src; i.alt = ""; i.loading = "lazy"; return i; }
function pill(text: string) { return el("span", "pp-pill", text); }
function separator() { return el("div", "pp-divider"); }
function textInput(placeholder: string, value = "") {
    const i = el("input", "pp-input"); i.type = "text"; i.placeholder = placeholder; i.value = value; return i;
}
function selectOption(text: string, value = text) { const o = el("option", "", text); o.value = value; return o; }
function selectBox(options: Array<{ name: string; value: string }>, selected: string) {
    const s = el("select", "pp-select"); for (const o of options) s.append(selectOption(o.name, o.value)); s.value = selected; return s;
}

function appendProfilePreview(host: HTMLElement, p: ProfilePreset, large = false) {
    const preview = el("div", `pp-art ${large ? "pp-art-large" : ""}`);
    const colors = p.themeColors?.map(colorHex).filter(Boolean) as string[] | undefined;
    if (colors?.length === 2) preview.style.background = `linear-gradient(130deg,${colors[0]},${colors[1]})`;
    else if (colorHex(p.accentColor)) preview.style.background = colorHex(p.accentColor)!;
    if (p.banner) preview.append(img(p.banner, "pp-banner"));
    if (p.avatar) {
        const avatar = el("div", "pp-avatar-wrap"); avatar.append(img(p.avatar, "pp-avatar"));
        // Discord's decoration assets are animated CDN assets; preview only when an asset is known.
        if (p.avatarDecorationAsset && /^[a-z0-9_]+$/i.test(p.avatarDecorationAsset)) {
            const deco = img(`https://cdn.discordapp.com/avatar-decoration-presets/${p.avatarDecorationAsset}.png?size=240`, "pp-deco");
            deco.onerror = () => deco.remove();
            avatar.append(deco);
        }
        preview.append(avatar);
    }
    if (large) {
        const overlay = el("div", "pp-art-overlay");
        overlay.append(el("div", "pp-art-name", p.displayName || p.name));
        const metadata = [
            p.nameplateSkuId ? "Nameplate saved" : null,
            p.profileEffectId ? "Profile effect saved (animation not shown)" : null,
            p.profileFrameSkuId ? "Frame saved (preview only)" : null
        ].filter(Boolean).join(" · ");
        overlay.append(el("div", "pp-art-metadata", metadata || "Avatar + banner preview"));
        if (p.displayNameColors?.length) {
            const swatches = el("div", "pp-swatches");
            for (const c of p.displayNameColors) {
                const hex = colorHex(c); if (!hex) continue;
                const swatch = el("span", "pp-swatch"); swatch.style.backgroundColor = hex; swatches.append(swatch);
            }
            overlay.append(swatches);
        }
        preview.append(overlay);
    }
    if (!large && p.customThumbnail) preview.append(img(p.customThumbnail, "pp-custom-thumb"));
    host.append(preview);
}

function closeModal() {
    const current = document.getElementById(MODAL_ID) as HTMLDialogElement | null;
    if (current) { if (current.open) current.close(); current.remove(); }
    modalGeneration++;
}
function modalCss() {
    return `
    #${MODAL_ID} { position:fixed!important; inset:0!important; margin:auto!important; padding:0!important; color:var(--text-normal,#f2f3f5); background:transparent; border:0; max-width:calc(100vw - 24px); max-height:calc(100vh - 24px); width:min(870px, calc(100vw - 24px)); overflow:visible; }
    #${MODAL_ID}::backdrop { background:rgba(0,0,0,.77); backdrop-filter:blur(5px) }
    #${MODAL_ID} *, #${MODAL_ID} *::before, #${MODAL_ID} *::after { box-sizing:border-box; }
    #${MODAL_ID} .pp-shell { background:var(--modal-background,#313338); border-radius:14px; padding:20px; max-height:calc(100vh - 40px); overflow:auto; box-shadow:0 22px 70px rgba(0,0,0,.65); font-family:var(--font-primary,sans-serif); font-size:14px; }
    #${MODAL_ID} .pp-top, #${MODAL_ID} .pp-inline, #${MODAL_ID} .pp-actions { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
    #${MODAL_ID} .pp-top { justify-content:space-between; margin-bottom:16px; }
    #${MODAL_ID} .pp-title { font-size:20px; font-weight:800; margin:0; color:var(--header-primary,#fff); }
    #${MODAL_ID} .pp-credit, #${MODAL_ID} .pp-muted { color:var(--text-muted,#b5bac1); font-size:12px; }
    #${MODAL_ID} .pp-btn { border:0; border-radius:6px; font-size:12px; line-height:1.4; padding:8px 11px; font-weight:700; cursor:pointer; background:var(--background-modifier-active,#4e5058); color:white; }
    #${MODAL_ID} .pp-btn:hover { filter:brightness(1.14); }
    #${MODAL_ID} .pp-btn:disabled { cursor:not-allowed; opacity:.45; }
    #${MODAL_ID} .pp-primary { background:var(--brand-500,#5865f2); }
    #${MODAL_ID} .pp-danger { background:var(--button-danger-background,#da373c); }
    #${MODAL_ID} .pp-input, #${MODAL_ID} .pp-select { min-width:0; max-width:100%; border:1px solid var(--background-modifier-accent,#555); outline:none; border-radius:6px; padding:9px 10px; background:var(--input-background,#1e1f22); color:var(--text-normal,#fff); font-size:13px; }
    #${MODAL_ID} .pp-input:focus, #${MODAL_ID} .pp-select:focus { border-color:var(--brand-500,#5865f2); }
    #${MODAL_ID} .pp-grow { flex:1; }
    #${MODAL_ID} .pp-label { font-size:12px; font-weight:700; color:var(--header-secondary,#dbdee1); }
    #${MODAL_ID} .pp-divider { height:1px; background:var(--background-modifier-accent,rgba(255,255,255,.12)); margin:15px 0; }
    #${MODAL_ID} .pp-options { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:7px; margin-top:12px; }
    #${MODAL_ID} .pp-check { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text-normal,#fff); }
    #${MODAL_ID} .pp-check input { cursor:pointer; }
    #${MODAL_ID} .pp-card { display:flex; align-items:stretch; gap:13px; background:var(--background-secondary,#2b2d31); border:1px solid var(--background-modifier-accent,#45474f); border-radius:10px; padding:11px; margin-bottom:10px; }
    #${MODAL_ID} .pp-card:hover { border-color:var(--brand-500,#5865f2); }
    #${MODAL_ID} .pp-art { position:relative; width:134px; height:96px; border-radius:8px; overflow:hidden; background:var(--background-tertiary,#1e1f22); flex-shrink:0; }
    #${MODAL_ID} .pp-banner, #${MODAL_ID} .pp-custom-thumb { width:100%; height:100%; object-fit:cover; position:absolute; inset:0; }
    #${MODAL_ID} .pp-avatar-wrap { position:absolute; left:9px; bottom:7px; width:52px; height:52px; border-radius:50%; border:3px solid var(--background-secondary,#2b2d31); }
    #${MODAL_ID} .pp-avatar { width:100%; height:100%; object-fit:cover; border-radius:50%; }
    #${MODAL_ID} .pp-deco { position:absolute; inset:-10%; width:120%; height:120%; object-fit:contain; pointer-events:none; }
    #${MODAL_ID} .pp-card-body { flex:1; min-width:0; display:flex; flex-direction:column; justify-content:space-between; }
    #${MODAL_ID} .pp-card-heading { font-size:15px; font-weight:800; color:var(--header-primary,#fff); overflow-wrap:anywhere; }
    #${MODAL_ID} .pp-pill { display:inline-block; padding:2px 6px; margin:3px 5px 0 0; font-size:11px; color:var(--text-muted,#ddd); background:var(--background-tertiary,#1e1f22); border-radius:5px; }
    #${MODAL_ID} .pp-art-large { width:100%; height:225px; margin:10px 0; }
    #${MODAL_ID} .pp-art-large .pp-avatar-wrap { left:18px; bottom:38px; width:82px; height:82px; }
    #${MODAL_ID} .pp-art-overlay { position:absolute; bottom:0; left:0; right:0; background:linear-gradient(transparent,rgba(0,0,0,.75)); padding:48px 16px 12px 115px; }
    #${MODAL_ID} .pp-art-name { font-weight:900; font-size:18px; overflow-wrap:anywhere; }
    #${MODAL_ID} .pp-art-metadata { font-size:11px; color:#ddd; }
    #${MODAL_ID} .pp-swatches { display:flex; gap:4px; margin-top:5px; }
    #${MODAL_ID} .pp-swatch { display:inline-block; height:10px; width:21px; border:1px solid rgba(255,255,255,.3); border-radius:3px; }
    #${MODAL_ID} .pp-extra { background:var(--background-tertiary,#1e1f22); border-radius:8px; padding:13px; margin:5px 0 11px; }
    #${MODAL_ID} .pp-status { padding:10px; border-radius:7px; background:var(--background-secondary,#2b2d31); font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; margin-bottom:12px; }
    #${MODAL_ID} .pp-stats { color:var(--text-muted,#b5bac1); font-size:12px; margin:8px 0; }
    @media (max-width:650px) { #${MODAL_ID} .pp-card { flex-wrap:wrap; } #${MODAL_ID} .pp-card-body { min-width:200px; } #${MODAL_ID} .pp-options { grid-template-columns:repeat(2,minmax(0,1fr)); } #${MODAL_ID} .pp-art { width:115px; height:85px; } }
    `;
}

async function exportPresets() {
    const presets = await readPresets();
    const blob = new Blob([JSON.stringify({ format: "ProfilePresets", version: 4, exportedAt: new Date().toISOString(), presets }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = el("a"); anchor.href = url; anchor.download = `ProfilePresets-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function importPresets(file: File) {
    if (file.size > 35 * 1024 * 1024) throw new Error("Backup exceeds 35 MB");
    const data = JSON.parse(await file.text());
    const array = Array.isArray(data) ? data : data?.format === "ProfilePresets" ? data.presets : null;
    if (!Array.isArray(array) || array.length > 200) throw new Error("Invalid backup format or too many presets");
    const existing = await readPresets();
    const ids = new Set(existing.map(p => p.id));
    const names = new Set(existing.map(p => p.name));
    const additions: ProfilePreset[] = [];
    for (const entry of array) {
        if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || entry.name.length > 80)
            throw new Error("Backup contains an invalid preset");
        const p = normalizePreset(entry);
        // Do not silently overwrite current presets.
        if (ids.has(p.id)) p.id = crypto.randomUUID();
        if (names.has(p.name)) {
            const base = p.name.slice(0, 58);
            let counter = 1;
            while (names.has(`${base} (imported ${counter})`)) counter++;
            p.name = `${base} (imported ${counter})`;
        }
        ids.add(p.id); names.add(p.name); additions.push(p);
    }
    await writePresets([...additions, ...existing]);
    return additions.length;
}

async function maybeRotate(force = false) {
    const config = await readConfig();
    if ((!config.rotationEnabled && !force) || busy) return;
    const frequency = config.rotationPeriod === "weekly" ? 7 * 86400000 : 86400000;
    if (!force && Date.now() - config.lastRotationAt < frequency) return;
    const presets = (await readPresets()).filter(p => p.inRotation);
    if (presets.length < 2) {
        if (config.rotationEnabled) { config.rotationEnabled = false; await writeConfig(config); toast("Rotation paused: mark at least two presets for rotation.", Toasts.Type.FAILURE); }
        return;
    }
    const idx = presets.findIndex(p => p.id === config.lastRotationId);
    const next = presets[(idx + 1) % presets.length];
    try {
        const result = await applyWithUndo(next, config.fields);
        if (result.errors.length || !result.accepted.length) {
            config.rotationEnabled = false;
            toast(`Rotation paused. ${reportText(result)}`, Toasts.Type.FAILURE);
        } else {
            config.lastRotationAt = Date.now(); config.lastRotationId = next.id;
            toast(`Rotation request sent for "${next.name}". Check Discord's profile to confirm.`, Toasts.Type.SUCCESS);
        }
        await writeConfig(config);
    } catch (e) {
        config.rotationEnabled = false; await writeConfig(config);
        toast(`Rotation paused: ${errMessage(e)}`, Toasts.Type.FAILURE);
    }
}

async function openModal() {
    closeModal();
    const generation = modalGeneration;
    const dialog = el("dialog"); dialog.id = MODAL_ID;
    const theme = el("style"); theme.textContent = modalCss(); dialog.append(theme);
    const shell = el("div", "pp-shell"); dialog.append(shell);
    const config = await readConfig();
    let presets = await readPresets();
    if (generation !== modalGeneration) return;

    const top = el("div", "pp-top");
    const heading = el("div"); heading.append(el("h2", "pp-title", "Profile Presets"), el("div", "pp-credit", "Created by twitch.tv/yonaaw_ & twitch.tv/Chihiroqt"));
    top.append(heading, btn("Close", closeModal)); shell.append(top);

    const status = el("div", "pp-status", "Ready. Preview cards are approximate. Discord may reject unsupported cosmetic updates.");
    const updateStatus = (message: string) => { status.textContent = message; };
    shell.append(status);

    const saveRow = el("div", "pp-inline");
    const nameInput = textInput("Preset name, e.g. Midnight Galaxy"); nameInput.classList.add("pp-grow");
    const save = btn("Save current profile", () => void saveCurrent(), "primary");
    saveRow.append(nameInput, save); shell.append(saveRow);

    const tools = el("div", "pp-inline"); style(tools, { marginTop: "12px" });
    const undo = btn("↶ Undo last switch", () => void undoLast());
    const exportButton = btn("Export backup", () => void exportPresets().catch(e => updateStatus(errMessage(e))));
    const importButton = btn("Import backup", () => importInput.click());
    const importInput = el("input"); importInput.type = "file"; importInput.accept = ".json,application/json"; importInput.hidden = true;
    importInput.onchange = () => void (async () => {
        if (!importInput.files?.[0]) return;
        try { const count = await importPresets(importInput.files[0]); presets = await readPresets(); updateStatus(`Imported ${count} presets without replacing existing presets.`); renderList(); }
        catch (e) { updateStatus(`Import failed: ${errMessage(e)}`); }
        importInput.value = "";
    })();
    tools.append(undo, exportButton, importButton, importInput); shell.append(tools);

    const checkArea = el("div", "pp-options");
    for (const { key, label } of FIELDS) {
        const line = el("label", "pp-check");
        const input = el("input"); input.type = "checkbox"; input.checked = Boolean(config.fields[key]);
        if (key === "frame") { input.disabled = true; input.title = "Discord does not expose a verified restore field for frames"; }
        input.onchange = () => { config.fields[key] = input.checked; void writeConfig(config); };
        line.append(input, document.createTextNode(label)); checkArea.append(line);
    }
    shell.append(el("div", "pp-label", "When applying a preset, change only these selected fields:"), checkArea);
    shell.append(separator());

    const organization = el("div", "pp-inline");
    const search = textInput("Search presets, tags, folders..."); search.value = config.filter; search.classList.add("pp-grow");
    const folderSelect = el("select", "pp-select");
    const count = el("div", "pp-stats");
    organization.append(search, folderSelect); shell.append(organization, count);

    const rotation = el("div", "pp-inline"); style(rotation, { margin: "10px 0 13px" });
    const rotatePeriod = selectBox([{ name: "Daily", value: "daily" }, { name: "Weekly", value: "weekly" }], config.rotationPeriod);
    rotatePeriod.onchange = () => { config.rotationPeriod = rotatePeriod.value as "daily" | "weekly"; void writeConfig(config); };
    const rotationState = el("span", "pp-muted");
    const rotationToggle = btn("", () => void toggleRotation());
    const rotateNow = btn("Switch to next now", () => void rotateImmediately());
    rotation.append(el("span", "pp-label", "Auto rotate:"), rotatePeriod, rotationToggle, rotateNow, rotationState);
    shell.append(rotation);
    function setRotationLabel() {
        rotationToggle.textContent = config.rotationEnabled ? "Disable" : "Enable";
        rotationState.textContent = config.rotationEnabled
            ? "Active while Discord is running. Pauses if updates fail."
            : "Off · mark at least 2 presets with ↻ to use";
    }
    setRotationLabel();
    async function toggleRotation() {
        if (!config.rotationEnabled && presets.filter(p => p.inRotation).length < 2) {
            updateStatus("Mark at least two preset cards with ↻ before enabling rotation."); return;
        }
        config.rotationEnabled = !config.rotationEnabled;
        if (config.rotationEnabled) config.lastRotationAt = Date.now(); // No sudden update on enabling.
        await writeConfig(config); setRotationLabel();
        updateStatus(config.rotationEnabled ? "Rotation enabled. First automatic switch will occur after the selected interval." : "Automatic rotation disabled.");
    }
    async function rotateImmediately() {
        if (busy) { updateStatus("Wait for the current profile update to finish."); return; }
        if (presets.filter(p => p.inRotation).length < 2) {
            updateStatus("Select at least two presets using ↻ before switching to the next one.");
            return;
        }
        updateStatus("Switching to the next rotation preset...");
        await maybeRotate(true);
        updateStatus("Rotation request finished. Confirm the appearance in Discord; failures also show in notifications and console.");
    }

    const list = el("div"); shell.append(list);
    let expanded: string | null = null;
    let editorOpen: string | null = null;

    async function saveCurrent() {
        const name = nameInput.value.trim();
        if (!name || busy) { updateStatus("Enter a preset name first, or wait for the current operation."); return; }
        busy = true; save.disabled = true;
        try {
            const snapshot = await readProfile(); snapshot.name = name.slice(0, 80);
            presets = [snapshot, ...presets]; await writePresets(presets);
            nameInput.value = "";
            updateStatus(`Saved "${snapshot.name}". ${FIELDS.filter(f => available(snapshot, f.key)).map(f => f.label).join(", ") || "No cosmetics detected"} captured.`);
            renderList();
        } catch (e) { updateStatus(`Saving failed: ${errMessage(e)}`); }
        finally { busy = false; save.disabled = false; }
    }
    async function saveChange(p: ProfilePreset) {
        presets = presets.map(item => item.id === p.id ? p : item);
        await writePresets(presets); renderList();
    }
    async function requestApply(p: ProfilePreset) {
        if (busy) return;
        updateStatus(`Saving undo snapshot and applying "${p.name}"...`);
        try {
            const report = await applyWithUndo(p, { ...config.fields });
            updateStatus(reportText(report));
            toast(report.errors.length ? "Profile partly applied; see Profile Presets for errors." : "Update requests finished; verify appearance in Discord.", report.errors.length ? Toasts.Type.FAILURE : Toasts.Type.SUCCESS);
        } catch (e) { updateStatus(`Could not apply: ${errMessage(e)}. No changes sent if undo snapshot failed.`); }
    }
    async function undoLast() {
        updateStatus("Restoring previous captured appearance...");
        try {
            const report = await undoSwitch(); updateStatus(`Undo: ${reportText(report)}`); }
        catch (e) { updateStatus(`Undo failed: ${errMessage(e)}`); }
    }

    function makeEditor(p: ProfilePreset) {
        const area = el("div", "pp-extra");
        area.append(el("div", "pp-label", "Edit preset (changes here do not modify your live profile)"));
        const row = el("div", "pp-inline"); style(row, { marginTop: "9px" });
        const editName = textInput("Name", p.name); editName.classList.add("pp-grow");
        const editFolder = textInput("Folder", p.folder || "Unsorted");
        const editTags = textInput("Tags (comma separated)", (p.tags || []).join(", "));
        row.append(editName, editFolder, editTags); area.append(row);
        const actions = el("div", "pp-inline"); style(actions, { marginTop: "9px" });
        const imageChooser = el("input"); imageChooser.type = "file"; imageChooser.accept = "image/png,image/jpeg,image/gif,image/webp"; imageChooser.hidden = true;
        let thumb: string | null = p.customThumbnail ?? null;
        imageChooser.onchange = () => void (async () => {
            const file = imageChooser.files?.[0]; if (!file) return;
            if (file.size > 3 * 1024 * 1024) { updateStatus("Thumbnail must be smaller than 3MB"); return; }
            try {
                const data = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(r.error); r.readAsDataURL(file); });
                thumb = safeImg(data); updateStatus("Thumbnail selected. Click Save details to keep it.");
            } catch (e) { updateStatus(`Thumbnail failed: ${errMessage(e)}`); }
        })();
        const editSave = btn("Save details", () => void (async () => {
            if (!editName.value.trim()) { updateStatus("Preset name must not be empty."); return; }
            p.name = editName.value.trim().slice(0, 80);
            p.folder = editFolder.value.trim().slice(0, 40) || "Unsorted";
            p.tags = parseTags(editTags.value);
            p.customThumbnail = thumb;
            editorOpen = null;
            await saveChange(p);
            updateStatus(`Updated details for ${p.name}.`);
        })(), "primary");
        const setThumb = btn("Set thumbnail", () => imageChooser.click());
        const clearThumb = btn("Clear thumbnail", () => { thumb = null; updateStatus("Thumbnail cleared. Click Save details to keep it."); });
        const overwrite = btn("Replace with current profile", () => void (async () => {
            if (busy) return; busy = true;
            try {
                const fresh = await readProfile();
                Object.assign(p, {
                    ...fresh, id: p.id, name: p.name, createdAt: p.createdAt,
                    favorite: p.favorite, folder: p.folder, tags: p.tags, inRotation: p.inRotation,
                    customThumbnail: p.customThumbnail
                });
                editorOpen = null;
                await saveChange(p); updateStatus(`Updated saved appearance for ${p.name}.`);
            } catch (e) { updateStatus(`Could not update appearance: ${errMessage(e)}`); }
            finally { busy = false; }
        })());
        actions.append(editSave, setThumb, clearThumb, overwrite, imageChooser); area.append(actions);
        area.append(el("div", "pp-muted", "Preview thumbnail is optional. Full preview still uses the saved avatar/banner; old data is preserved when editing labels."));
        return area;
    }

    function renderList() {
        list.replaceChildren();
        folderSelect.replaceChildren(selectOption("All folders"));
        const folders = [...new Set(presets.map(p => p.folder || "Unsorted"))].sort((a, b) => a.localeCompare(b));
        for (const folder of folders) folderSelect.append(selectOption(folder));
        folderSelect.value = config.folder;
        if (!folderSelect.value) { config.folder = "All folders"; folderSelect.value = "All folders"; }
        const filter = config.filter.toLowerCase().trim();
        const matches = presets.filter(p =>
            (config.folder === "All folders" || (p.folder || "Unsorted") === config.folder) &&
            (!filter || [p.name, p.folder || "", ...(p.tags || [])].join(" ").toLowerCase().includes(filter))
        ).sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || b.createdAt - a.createdAt);
        count.textContent = `${matches.length} of ${presets.length} presets · ★ favorite · ↻ include in rotation`;
        if (!matches.length) list.append(el("p", "pp-muted", "No presets match your search. Save a profile above or import a backup."));
        for (const p of matches) {
            const card = el("div", "pp-card");
            appendProfilePreview(card, p);
            const body = el("div", "pp-card-body");
            const caption = el("div"); caption.append(el("div", "pp-card-heading", p.name));
            caption.append(el("div", "pp-muted", `${p.folder || "Unsorted"} · ${new Date(p.createdAt).toLocaleDateString()}`));
            for (const f of FIELDS) if (available(p, f.key)) caption.append(pill(f.label));
            for (const tag of p.tags || []) caption.append(pill(`#${tag}`));
            body.append(caption);
            const controls = el("div", "pp-actions"); style(controls, { marginTop: "8px" });
            controls.append(
                btn("Apply", () => void requestApply(p), "primary"),
                btn(expanded === p.id ? "Hide preview" : "Preview", () => { expanded = expanded === p.id ? null : p.id; renderList(); }),
                btn(editorOpen === p.id ? "Cancel edit" : "Edit", () => { editorOpen = editorOpen === p.id ? null : p.id; renderList(); }),
                btn(p.favorite ? "★" : "☆", () => void (async () => { p.favorite = !p.favorite; await saveChange(p); })()),
                btn(p.inRotation ? "↻ On" : "↻ Off", () => void (async () => { p.inRotation = !p.inRotation; await saveChange(p); })()),
                btn("Delete", () => void (async () => {
                    if (!window.confirm(`Delete preset "${p.name}"?`)) return;
                    presets = presets.filter(item => item.id !== p.id); await writePresets(presets);
                    updateStatus(`Deleted "${p.name}".`); renderList();
                })(), "danger")
            );
            body.append(controls); card.append(body);
            const wrapper = el("div"); wrapper.append(card);
            if (expanded === p.id) {
                const detail = el("div", "pp-extra");
                detail.append(el("div", "pp-label", "Saved profile preview (effects and some collectibles cannot be rendered exactly)"));
                appendProfilePreview(detail, p, true);
                detail.append(el("div", "pp-muted", `Decoration SKU: ${p.avatarDecorationSkuId || "not captured"} · Nameplate SKU: ${p.nameplateSkuId || "not captured"} · Effect ID: ${p.profileEffectId || "not captured"} · Frame SKU: ${p.profileFrameSkuId || "not captured"}`));
                wrapper.append(detail);
            }
            if (editorOpen === p.id) wrapper.append(makeEditor(p));
            list.append(wrapper);
        }
    }
    search.oninput = () => { config.filter = search.value; void writeConfig(config); renderList(); };
    folderSelect.onchange = () => { config.folder = folderSelect.value; void writeConfig(config); renderList(); };
    renderList();

    shell.append(separator(), el("div", "pp-muted", "Local presets only. Importing shares image data and cosmetic IDs, not account credentials. Only owned/eligible cosmetics can be equipped. Automated rotation works only while Discord is open."));
    dialog.onclick = e => { if (e.target === dialog) closeModal(); };
    dialog.oncancel = e => { e.preventDefault(); closeModal(); };
    document.body.append(dialog);
    dialog.showModal();
    nameInput.focus({ preventScroll: true });
}

function isProfilesPage() {
    const page = document.body?.innerText || "";
    return page.includes("Avatar & Decoration") && page.includes("Theme & Banner") && page.includes("Profile Effect & Frame");
}
function injectButton() {
    if (!isProfilesPage()) { document.getElementById(BUTTON_ID)?.remove(); return; }
    if (document.getElementById(BUTTON_ID)) return;
    const button = btn("Profile Presets", () => void openModal(), "primary"); button.id = BUTTON_ID;
    style(button, {
        position: "fixed", left: "18px", bottom: "18px", zIndex: "9999",
        padding: "12px 16px", border: "none", borderRadius: "8px",
        background: "var(--brand-500,#5865f2)", color: "white", fontWeight: "700", cursor: "pointer",
        boxShadow: "0 8px 24px rgba(0,0,0,.3)"
    });
    document.body.append(button);
}

export default definePlugin({
    name: "ProfilePresets",
    description: "Save, preview, edit, import/export, selectively apply and rotate Discord profile presets. By twitch.tv/yonaaw_ & twitch.tv/Chihiroqt.",
    authors: [{ name: "twitch.tv/yonaaw_", id: 0n }, { name: "twitch.tv/Chihiroqt", id: 0n }],
    start() {
        observer = new MutationObserver(injectButton);
        observer.observe(document.body, { childList: true, subtree: true });
        refreshTimer = window.setInterval(injectButton, 1200);
        rotationTimer = window.setInterval(() => void maybeRotate().catch(console.error), 5 * 60000);
        injectButton();
    },
    stop() {
        observer?.disconnect(); observer = null;
        if (refreshTimer !== null) clearInterval(refreshTimer);
        if (rotationTimer !== null) clearInterval(rotationTimer);
        refreshTimer = rotationTimer = null;
        document.getElementById(BUTTON_ID)?.remove(); closeModal();
    }
});
