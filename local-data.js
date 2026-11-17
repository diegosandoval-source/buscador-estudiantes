const databaseName = 'buscador-estudiantes-local-v1';
const storeName = 'data';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let opened;

function database() {
    if (!opened) {
        opened = new Promise((resolve, reject) => {
            const request = indexedDB.open(databaseName, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(storeName);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error('No se pudo abrir el almacenamiento de este navegador.'));
        });
    }
    return opened;
}

async function read(key) {
    const db = await database();
    return new Promise((resolve, reject) => {
        const request = db.transaction(storeName).objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(new Error('No se pudieron leer los datos guardados.'));
    });
}

export function readVault() {
    return read('vault');
}

async function deriveKey(password, salt) {
    const raw = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, raw,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
}

export async function unlock(password, envelope) {
    const key = await deriveKey(password, envelope.salt);
    let data;
    try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: envelope.iv }, key, envelope.ciphertext);
        data = JSON.parse(decoder.decode(plain));
    } catch {
        throw new Error('La contraseña no coincide con el acceso de este navegador.');
    }
    if (data.version !== 1 || !Array.isArray(data.students) || !Array.isArray(data.tutors) || !Array.isArray(data.folios)) {
        throw new Error('El almacenamiento local tiene un formato desconocido.');
    }
    return { key, salt: envelope.salt, revision: envelope.revision, data };
}

export async function createVault(password) {
    if (password.length < 12) throw new Error('Usa una contraseña de al menos 12 caracteres.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt);
    const session = { key, salt, revision: 0 };
    session.data = { version: 1, students: [], tutors: [], folios: [] };
    return saveVault(session, session.data);
}

async function codeHash(code) {
    const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(code));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function saveVault(session, data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, session.key, encoder.encode(JSON.stringify(data))
    );
    const revision = session.revision + 1;
    const envelope = { iv, ciphertext, salt: session.salt, revision };
    const published = await Promise.all(data.folios.filter((folio) => folio.published).map(async (folio) => [
        await codeHash(folio.code),
        { annulled: folio.annulled, expiresOn: folio.expiresOn }
    ]));
    const db = await database();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const current = store.get('vault');
        let changed = false;
        current.onsuccess = () => {
            if ((current.result?.revision ?? 0) !== session.revision) {
                changed = true;
                tx.abort();
                return;
            }
            store.put(envelope, 'vault');
            store.put(Object.fromEntries(published), 'public');
        };
        tx.oncomplete = resolve;
        tx.onabort = () => reject(new Error(changed
            ? 'Los datos cambiaron en otra pestaña. Cierra sesión y vuelve a entrar.'
            : 'No se pudieron guardar los cambios en este navegador.'));
    });
    return { ...session, revision, data };
}

export function newCode() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function todayInChile(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en', {
        timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
}

export function folioStatus(folio, today = todayInChile()) {
    if (!folio) return 'no_existe';
    if (folio.annulled) return 'anulado';
    if (folio.expiresOn && folio.expiresOn < today) return 'vencido';
    return 'vigente';
}

export async function validateCode(value) {
    const code = value.trim().toLowerCase().replaceAll('-', '');
    if (!/^[0-9a-f]{32}$/.test(code)) throw new Error('Ingresa un folio completo de 32 caracteres.');
    const catalog = await read('public');
    return folioStatus(catalog?.[await codeHash(code)]);
}
