/*
 * Profile Presets - Vencord userplugin
 * Save as: src/userplugins/profilePresets/index.ts
 *
 * Adds a Profile Presets button directly to Discord's Profiles page.
 * Presets are saved locally in Vencord.
 */

import * as DataStore from "@api/DataStore";
import definePlugin from "@utils/types";
import { findStoreLazy } from "@webpack";
import { RestAPI, showToast, Toasts, UserStore } from "@webpack/common";

const STORE_KEY = "ProfilePresets_v2";
const BUTTON_ID = "vc-profile-presets-button";
const MODAL_ID = "vc-profile-presets-modal";

interface DecorationData {
    asset: string | null;
    skuId: string | null;
}

interface ProfilePreset {
    id: string;
    name: string;
    createdAt: number;
    avatar: string | null;
    banner: string | null;
    accentColor: number | null;
    themeColors: [number, number] | null;
    decoration: DecorationData | null;
    profileEffectId: string | null;
}

const UserProfileStore = findStoreLazy("UserProfileStore");

function toast(message: string, type = Toasts.Type.MESSAGE) {
    showToast(message, type);
}

async function getPresets(): Promise<ProfilePreset[]> {
    const value = await DataStore.get(STORE_KEY);
    return Array.isArray(value) ? value : [];
}

async function setPresets(presets: ProfilePreset[]) {
    await DataStore.set(STORE_KEY, presets);
}

function cdnUrl(type: "avatars" | "banners", userId: string, hash: string) {
    const extension = hash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/${type}/${userId}/${hash}.${extension}?size=1024`;
}

async function imageToDataUri(url: string): Promise<string> {
    const response = await fetch(url);

    if (!response.ok)
        throw new Error(`Could not download image (${response.status})`);

    const blob = await response.blob();

    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
        reader.readAsDataURL(blob);
    });
}

async function fetchCurrentProfile(userId: string): Promise<any> {
    const cached = UserProfileStore.getUserProfile?.(userId);

    if (cached)
        return cached;

    const response = await RestAPI.get({
        url: `/users/${userId}/profile`,
        query: {
            with_mutual_guilds: false,
            with_mutual_friends_count: false
        }
    });

    return response?.body?.user_profile ?? response?.body ?? {};
}

function readDecoration(user: any): DecorationData | null {
    const value = user?.avatarDecorationData ?? user?.avatar_decoration_data;

    if (!value)
        return null;

    return {
        asset: value.asset ?? null,
        skuId: value.skuId ?? value.sku_id ?? null
    };
}

async function capturePreset(name: string): Promise<ProfilePreset> {
    const user: any = UserStore.getCurrentUser();

    if (!user)
        throw new Error("Discord has not loaded your account yet.");

    const profile = await fetchCurrentProfile(user.id);

    const avatarHash = user.avatar ?? null;
    const bannerHash = user.banner ?? profile.banner ?? null;

    const avatar = avatarHash
        ? await imageToDataUri(cdnUrl("avatars", user.id, avatarHash))
        : null;

    const banner = bannerHash
        ? await imageToDataUri(cdnUrl("banners", user.id, bannerHash))
        : null;

    const rawThemeColors = profile.themeColors ?? profile.theme_colors ?? null;

    const themeColors =
        Array.isArray(rawThemeColors) && rawThemeColors.length >= 2
            ? [Number(rawThemeColors[0]), Number(rawThemeColors[1])] as [number, number]
            : null;

    return {
        id: crypto.randomUUID(),
        name,
        createdAt: Date.now(),
        avatar,
        banner,
        accentColor: profile.accentColor ?? profile.accent_color ?? null,
        themeColors,
        decoration: readDecoration(user),
        profileEffectId: profile.profileEffectId ?? profile.profile_effect_id ?? null
    };
}

async function patchProfile(body: Record<string, unknown>) {
    await RestAPI.patch({
        url: "/users/@me",
        body
    });
}

async function applyPreset(preset: ProfilePreset): Promise<string[]> {
    const failures: string[] = [];

    // Apply each section independently, so a rejected premium item does not
    // prevent the avatar or banner from changing.
    try {
        await patchProfile({ avatar: preset.avatar });
    } catch (error) {
        console.error("[ProfilePresets] Avatar failed", error);
        failures.push("avatar");
    }

    try {
        await patchProfile({ banner: preset.banner });
    } catch (error) {
        console.error("[ProfilePresets] Banner failed", error);
        failures.push("banner");
    }

    try {
        await patchProfile({
            accent_color: preset.accentColor,
            theme_colors: preset.themeColors
        });
    } catch (error) {
        console.error("[ProfilePresets] Colours failed", error);
        failures.push("colours");
    }

    try {
        await patchProfile({
            avatar_decoration_id: preset.decoration?.skuId ?? null
        });
    } catch (error) {
        console.error("[ProfilePresets] Decoration failed", error);
        failures.push("decoration");
    }

    try {
        await patchProfile({
            profile_effect_id: preset.profileEffectId
        });
    } catch (error) {
        console.error("[ProfilePresets] Effect failed", error);
        failures.push("effect");
    }

    return failures;
}

function css(element: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(element.style, styles);
}

function makeButton(text: string, kind: "primary" | "danger" | "secondary" = "primary") {
    const button = document.createElement("button");
    button.textContent = text;

    css(button, {
        border: "none",
        borderRadius: "4px",
        padding: "9px 14px",
        fontWeight: "600",
        cursor: "pointer",
        color: "white",
        background:
            kind === "danger"
                ? "var(--button-danger-background, #da373c)"
                : kind === "secondary"
                    ? "var(--background-modifier-active, #4e5058)"
                    : "var(--button-positive-background, #5865f2)"
    });

    return button;
}

function closeModal() {
    const modal = document.getElementById(MODAL_ID) as HTMLDialogElement | null;

    if (!modal)
        return;

    if (modal.open)
        modal.close();

    modal.remove();
}

async function openModal() {
    closeModal();

    const overlay = document.createElement("dialog");
    overlay.id = MODAL_ID;

    css(overlay, {
        position: "fixed",
        inset: "0",
        margin: "auto",
        border: "none",
        padding: "0",
        width: "fit-content",
        height: "fit-content",
        maxWidth: "none",
        maxHeight: "none",
        color: "inherit",
        background: "transparent",
        overflow: "visible"
    });

    const backdropStyle = document.createElement("style");
    backdropStyle.textContent = `
        #${MODAL_ID}::backdrop {
            background: rgba(0, 0, 0, 0.82);
            backdrop-filter: blur(4px);
        }
    `;
    overlay.append(backdropStyle);

    const modal = document.createElement("div");

    css(modal, {
        width: "min(560px, calc(100vw - 40px))",
        maxHeight: "min(720px, calc(100vh - 40px))",
        overflow: "auto",
        padding: "20px",
        borderRadius: "12px",
        color: "var(--text-normal, white)",
        background: "var(--modal-background, #313338)",
        boxShadow: "0 20px 60px rgba(0,0,0,.55)",
        pointerEvents: "auto",
        position: "relative"
    });

    // Prevent Discord's profile editor behind the modal from receiving clicks.
    const stopEvent = (event: Event) => event.stopPropagation();
    for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
        modal.addEventListener(eventName, stopEvent);
    }

    const header = document.createElement("div");
    css(header, {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "16px"
    });

    const title = document.createElement("h2");
    title.textContent = "Profile Presets";
    css(title, { margin: "0", color: "var(--header-primary, white)" });

    const close = makeButton("Close", "secondary");
    close.onclick = closeModal;

    header.append(title, close);

    const saveRow = document.createElement("div");
    css(saveRow, {
        display: "flex",
        gap: "10px",
        marginBottom: "18px"
    });

    const input = document.createElement("input");
    input.placeholder = "Preset name, for example Pink";
    css(input, {
        flex: "1",
        minWidth: "0",
        border: "none",
        outline: "none",
        borderRadius: "4px",
        padding: "10px 12px",
        color: "var(--text-normal, white)",
        background: "var(--input-background, #1e1f22)",
        pointerEvents: "auto",
        userSelect: "text",
        position: "relative",
        zIndex: "2"
    });

    for (const eventName of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
        input.addEventListener(eventName, stopEvent);
    }

    const save = makeButton("Save current");
    save.onclick = async () => {
        const name = input.value.trim();

        if (!name) {
            toast("Give the preset a name first.", Toasts.Type.FAILURE);
            return;
        }

        save.disabled = true;
        save.textContent = "Saving…";

        try {
            const preset = await capturePreset(name);
            const presets = await getPresets();
            await setPresets([preset, ...presets]);
            toast(`Saved "${name}".`, Toasts.Type.SUCCESS);
            await openModal();
        } catch (error) {
            console.error("[ProfilePresets] Save failed", error);
            toast(
                `Could not save profile: ${error instanceof Error ? error.message : String(error)}`,
                Toasts.Type.FAILURE
            );
            save.disabled = false;
            save.textContent = "Save current";
        }
    };

    saveRow.append(input, save);

    const list = document.createElement("div");
    const presets = await getPresets();

    if (presets.length === 0) {
        const empty = document.createElement("p");
        empty.textContent = "No profile presets saved yet.";
        css(empty, { color: "var(--text-muted, #b5bac1)" });
        list.append(empty);
    }

    for (const preset of presets) {
        const card = document.createElement("div");

        css(card, {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            padding: "13px",
            marginBottom: "10px",
            borderRadius: "8px",
            background: "var(--background-secondary, #2b2d31)"
        });

        const preview = document.createElement("div");
        css(preview, {
            position: "relative",
            width: "88px",
            height: "56px",
            flexShrink: "0",
            overflow: "hidden",
            borderRadius: "8px",
            background: "var(--background-tertiary, #1e1f22)",
            border: "1px solid var(--background-modifier-accent, rgba(255,255,255,.08))"
        });

        if (preset.banner) {
            const bannerPreview = document.createElement("img");
            bannerPreview.src = preset.banner;
            bannerPreview.alt = "";
            css(bannerPreview, {
                width: "100%",
                height: "100%",
                display: "block",
                objectFit: "cover"
            });
            preview.append(bannerPreview);
        } else if (preset.themeColors) {
            const [primary, secondary] = preset.themeColors;
            preview.style.background = `linear-gradient(135deg, #${primary.toString(16).padStart(6, "0")}, #${secondary.toString(16).padStart(6, "0")})`;
        } else if (preset.accentColor !== null) {
            preview.style.background = `#${preset.accentColor.toString(16).padStart(6, "0")}`;
        }

        if (preset.avatar) {
            const avatarPreview = document.createElement("img");
            avatarPreview.src = preset.avatar;
            avatarPreview.alt = "";
            css(avatarPreview, {
                position: "absolute",
                left: "6px",
                bottom: "5px",
                width: "34px",
                height: "34px",
                objectFit: "cover",
                borderRadius: "50%",
                border: "3px solid var(--background-secondary, #2b2d31)",
                background: "var(--background-secondary, #2b2d31)"
            });
            preview.append(avatarPreview);
        }

        const info = document.createElement("div");
        css(info, { minWidth: "0", flex: "1" });

        const presetName = document.createElement("div");
        presetName.textContent = preset.name;
        css(presetName, {
            fontWeight: "700",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
        });

        const details = document.createElement("div");
        details.textContent = [
            preset.avatar ? "Avatar" : null,
            preset.banner ? "Banner" : null,
            preset.themeColors || preset.accentColor !== null ? "Colours" : null,
            preset.decoration?.skuId ? "Decoration" : null,
            preset.profileEffectId ? "Effect" : null
        ].filter(Boolean).join(" · ") || "Empty preset";

        css(details, {
            marginTop: "3px",
            fontSize: "12px",
            color: "var(--text-muted, #b5bac1)"
        });

        info.append(presetName, details);

        const actions = document.createElement("div");
        css(actions, { display: "flex", gap: "8px", flexShrink: "0" });

        const apply = makeButton("Apply");
        apply.onclick = async () => {
            apply.disabled = true;
            apply.textContent = "Applying…";

            const failures = await applyPreset(preset);

            if (failures.length === 0) {
                toast(`Applied "${preset.name}".`, Toasts.Type.SUCCESS);
                closeModal();
            } else {
                toast(
                    `Applied what Discord accepted. Failed: ${failures.join(", ")}.`,
                    Toasts.Type.FAILURE
                );
                apply.disabled = false;
                apply.textContent = "Apply";
            }
        };

        const remove = makeButton("Delete", "danger");
        remove.onclick = async () => {
            await setPresets(presets.filter(item => item.id !== preset.id));
            toast(`Deleted "${preset.name}".`, Toasts.Type.SUCCESS);
            await openModal();
        };

        actions.append(apply, remove);
        card.append(preview, info, actions);
        list.append(card);
    }

    modal.append(header, saveRow, list);
    overlay.append(modal);

    overlay.addEventListener("click", event => {
        if (event.target === overlay)
            closeModal();
    });

    overlay.addEventListener("cancel", event => {
        event.preventDefault();
        closeModal();
    });

    document.body.append(overlay);
    overlay.showModal();

    window.setTimeout(() => {
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
    }, 50);
}

function isProfilesPage() {
    const text = document.body?.innerText ?? "";

    return (
        text.includes("Avatar & Decoration") &&
        text.includes("Theme & Banner") &&
        text.includes("Profile Effect & Frame")
    );
}

function injectButton() {
    if (!isProfilesPage()) {
        document.getElementById(BUTTON_ID)?.remove();
        return;
    }

    if (document.getElementById(BUTTON_ID))
        return;

    const button = makeButton("Profile Presets");
    button.id = BUTTON_ID;
    button.onclick = () => void openModal();

    css(button, {
        position: "fixed",
        left: "18px",
        bottom: "18px",
        zIndex: "9999",
        padding: "11px 16px",
        borderRadius: "8px",
        boxShadow: "0 8px 24px rgba(0,0,0,.35)"
    });

    document.body.append(button);
}

let observer: MutationObserver | null = null;
let interval: number | null = null;

export default definePlugin({
    name: "ProfilePresets",
    description: "Save and apply profile presets from Discord's Profiles page.",
    authors: [
        {
            name: "twitch.tv/yonaaw_",
            id: 0n
        },
        {
            name: "twitch.tv/Chihiroqt",
            id: 0n
        }
    ],

    start() {
        observer = new MutationObserver(injectButton);
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });

        interval = window.setInterval(injectButton, 1000);
        injectButton();
    },

    stop() {
        observer?.disconnect();
        observer = null;

        if (interval !== null)
            window.clearInterval(interval);

        interval = null;
        document.getElementById(BUTTON_ID)?.remove();
        closeModal();
    }
});