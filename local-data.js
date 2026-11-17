const databaseName = 'buscador-estudiantes-local-v1';
const storeName = 'data';
const vaultSlot = 'vault-v2';
const publicSlot = 'public';
const accessSlot = 'access-v2';
const academicFields = ['academic_name', 'academic_phone', 'academic_email'];
const financialFields = ['financial_name', 'financial_phone', 'financial_email'];
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

function decodeBytes(value) {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export async function hasAccessFile() {
    return Boolean(await read(accessSlot));
}

export async function activateAccount(file, username, password) {
    const wrongWorkbook = 'Este paso requiere accesos-buscador.xlsx. La planilla de estudiantes se sube después de entrar, en Cargar datos de Excel.';
    if (!/\.xlsx$/i.test(file.name) || file.size > 128 * 1024) throw new Error(wrongWorkbook);
    if (!globalThis.XLSX) throw new Error('No se cargó el lector de Excel. Recarga la página e intenta nuevamente.');
    let accounts;
    try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new Error();
        const book = globalThis.XLSX.read(bytes, { type: 'array', sheets: 'Accesos', sheetRows: 9 });
        const cell = book.Sheets.Accesos?.C9;
        if (typeof cell?.v !== 'string' || cell.f || cell.v.length > 4000) throw new Error();
        const parsed = JSON.parse(cell.v);
        if (parsed.version !== 2 || Object.keys(parsed.accounts).length !== 2) throw new Error();
        accounts = Object.fromEntries(['admin', 'enfermeria'].map((username) => {
            const { salt, iv, ciphertext } = parsed.accounts[username];
            if (![salt, iv, ciphertext].every((value) => typeof value === 'string' && /^[a-z0-9+/]+={0,2}$/i.test(value))
                || decodeBytes(salt).length !== 16 || decodeBytes(iv).length !== 12
                || decodeBytes(ciphertext).length < 70 || decodeBytes(ciphertext).length > 256) throw new Error();
            return [username, { salt, iv, ciphertext }];
        }));
    } catch {
        throw new Error(wrongWorkbook);
    }
    const account = await authenticate(accounts, username, password);
    const db = await database();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const request = tx.objectStore(storeName).add(accounts, accessSlot);
        tx.oncomplete = resolve;
        tx.onabort = () => reject(new Error(request.error?.name === 'ConstraintError'
            ? 'Este navegador ya tiene un archivo de accesos.' : 'No se pudo guardar el archivo de accesos.'));
    });
    return loadAccount(account);
}

async function deriveKey(password, salt) {
    const raw = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, raw,
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
}

async function unlockLegacy(password, envelope) {
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
    return data;
}

async function importDataKey(encoded) {
    return crypto.subtle.importKey('raw', decodeBytes(encoded), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function authenticate(accounts, username, password) {
    const account = Object.hasOwn(accounts, username) ? accounts[username] : null;
    if (!account) throw new Error('Usuario o contraseña incorrectos.');
    const key = await deriveKey(password, decodeBytes(account.salt));
    let material;
    try {
        const plain = await crypto.subtle.decrypt({
            name: 'AES-GCM', iv: decodeBytes(account.iv), additionalData: encoder.encode('cuenta:' + username)
        }, key, decodeBytes(account.ciphertext));
        material = JSON.parse(decoder.decode(plain));
    } catch {
        throw new Error('Usuario o contraseña incorrectos.');
    }
    return {
        username,
        sharedKey: await importDataKey(material.shared),
        privateKey: material.private ? await importDataKey(material.private) : null
    };
}

function emptyData() {
    return { version: 1, students: [], tutors: [], folios: [] };
}

async function encryptData(key, data, scope) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(scope) }, key, encoder.encode(JSON.stringify(data))
    );
    return { iv, ciphertext };
}

async function decryptData(key, envelope, scope) {
    try {
        const plain = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: envelope.iv, additionalData: encoder.encode(scope) }, key, envelope.ciphertext
        );
        return JSON.parse(decoder.decode(plain));
    } catch {
        throw new Error('No se pudieron abrir las fichas de este navegador.');
    }
}

export async function openAccount(username, password) {
    const accounts = await read(accessSlot);
    if (!accounts) throw new Error('Primero carga el archivo de accesos de este navegador.');
    return loadAccount(await authenticate(accounts, username, password));
}

async function loadAccount(account) {
    const envelope = await read(vaultSlot);
    if (envelope) {
        const shared = await decryptData(account.sharedKey, envelope.shared, 'fichas:v2');
        const privateData = account.privateKey && envelope.private
            ? await decryptData(account.privateKey, envelope.private, 'administracion:v2') : null;
        const students = privateData ? shared.students.map((student) => ({
            ...student, ...privateData.financial[student.id]
        })) : shared.students;
        return { session: { ...account, revision: envelope.revision, data: {
            version: 1, students, tutors: shared.tutors, folios: privateData?.folios ?? []
        } } };
    }
    if (await read('vault')) {
        if (!account.privateKey) throw new Error('Administración debe recuperar las fichas anteriores en este navegador.');
        return { migration: account };
    }
    const data = emptyData();
    return { session: await saveVault({ ...account, revision: 0, data }, data, 0) };
}

export async function migrateLegacy(account, password) {
    if (!account.privateKey) throw new Error('La recuperación está disponible para Administración.');
    const legacy = await read('vault');
    if (!legacy) throw new Error('No hay fichas de la versión anterior en este navegador.');
    const data = await unlockLegacy(password, legacy);
    return saveVault({ ...account, revision: 0, data: emptyData() }, data, legacy.revision);
}

async function codeHash(code) {
    const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(code));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function pick(record, keys) {
    return Object.fromEntries(keys.map((key) => [key, record[key] ?? '']));
}

function withAcademicChanges(previous, submitted) {
    const previousIds = new Set(previous.map((record) => record.id));
    const updates = new Map(submitted.map((record) => [record.id, record]));
    return [
        ...previous.map((record) => ({
            ...record, ...pick(updates.get(record.id) ?? record, academicFields)
        })),
        ...submitted.filter((record) => !previousIds.has(record.id))
    ];
}

export async function saveVault(session, data, expectedLegacyRevision) {
    const admin = Boolean(session.privateKey);
    const revision = session.revision + 1;
    const submitted = admin ? data.students : withAcademicChanges(session.data.students, data.students);
    const students = submitted.map(({ id, name, course, ...contacts }) => ({
        id, name, course, ...pick(contacts, academicFields)
    }));
    const tutors = admin ? data.tutors : session.data.tutors;
    const shared = await encryptData(session.sharedKey, { students, tutors }, 'fichas:v2');
    const privateData = admin ? {
        financial: Object.fromEntries(submitted.map((record) => [record.id, pick(record, financialFields)])),
        folios: data.folios
    } : null;
    const sealedPrivate = admin ? await encryptData(session.privateKey, privateData, 'administracion:v2') : null;
    const published = await Promise.all((privateData?.folios ?? []).filter((folio) => folio.published).map(async (folio) => [
        await codeHash(folio.code),
        { annulled: folio.annulled, expiresOn: folio.expiresOn }
    ]));
    const db = await database();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const current = store.get(vaultSlot);
        let changed = false;
        current.onsuccess = () => {
            if ((current.result?.revision ?? 0) !== session.revision) {
                changed = true;
                tx.abort();
                return;
            }
            const write = () => {
                store.put({ shared, private: admin ? sealedPrivate : current.result?.private ?? null, revision }, vaultSlot);
                if (admin) store.put(Object.fromEntries(published), publicSlot);
            };
            if (expectedLegacyRevision === undefined) {
                write();
                return;
            }
            const legacy = store.get('vault');
            legacy.onsuccess = () => {
                if ((legacy.result?.revision ?? 0) === expectedLegacyRevision) write();
                else {
                    changed = true;
                    tx.abort();
                }
            };
        };
        tx.oncomplete = resolve;
        tx.onabort = () => reject(new Error(changed
            ? 'Los datos cambiaron en otra pestaña. Cierra sesión y vuelve a entrar.'
            : 'No se pudieron guardar los cambios en este navegador.'));
    });
    return { ...session, revision, data: admin ? data : { version: 1, students, tutors, folios: [] } };
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
    const catalog = await read(publicSlot);
    return folioStatus(catalog?.[await codeHash(code)]);
}
