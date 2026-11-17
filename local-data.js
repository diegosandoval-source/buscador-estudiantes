const databaseName = 'buscador-estudiantes-local-v1';
const storeName = 'data';
const vaultSlot = 'vault-v2';
const publicSlot = 'public';
const accessSlot = 'access-v2';
const simpleAdminPassword = '1234';
const academicFields = ['academic_name', 'academic_phone', 'academic_email'];
const privateFields = ['financial_name', 'financial_phone', 'financial_email', 'rut'];
const validationFields = ['id', 'studentId', 'code', 'type', 'issuedOn', 'expiresOn', 'state', 'notes'];
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

function encodeBytes(value) {
    const bytes = new Uint8Array(value);
    let text = '';
    for (let offset = 0; offset < bytes.length; offset += 16384) {
        text += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
    }
    return btoa(text);
}

export async function hasAccessFile() {
    return Boolean(await read(accessSlot));
}

export async function activateAccount(file, username, password) {
    const wrongWorkbook = 'Este paso requiere accesos-buscador.xlsx. La planilla de alumnos se importa dentro del panel.';
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
    return finishSignIn(account);
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
        original: account,
        material,
        sharedKey: await importDataKey(material.shared),
        privateKey: material.private ? await importDataKey(material.private) : null
    };
}

function emptyData() {
    return { version: 1, students: [], tutors: [], folios: [], validations: [] };
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
    if (username === 'admin' && password === simpleAdminPassword) {
        if (accounts?.admin?.simpleAccess) return loadAccount(await authenticate(accounts, username, password));
        if (accounts || await read(vaultSlot) || await read('vault')) return { accessUpdate: true };
        return installSimpleAdmin();
    }
    if (!accounts) throw new Error('Usuario o contraseña incorrectos.');
    return finishSignIn(await authenticate(accounts, username, password));
}

async function wrapSimpleAdmin(material) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(simpleAdminPassword, salt);
    const wrapped = await encryptData(key, material, 'cuenta:admin');
    return {
        salt: encodeBytes(salt), iv: encodeBytes(wrapped.iv), ciphertext: encodeBytes(wrapped.ciphertext),
        passwordChanged: true, simpleAccess: true
    };
}

async function installSimpleAdmin(previousPassword) {
    const [accounts, envelope, legacy] = await Promise.all([read(accessSlot), read(vaultSlot), read('vault')]);
    if (accounts?.admin?.simpleAccess) return loadAccount(await authenticate(accounts, 'admin', simpleAdminPassword));
    let material;
    let data = emptyData();
    let recoveredLegacyRevision = envelope?.recoveredLegacyRevision ?? 0;
    if (accounts) {
        if (!previousPassword) return { accessUpdate: true };
        const account = await authenticate(accounts, 'admin', previousPassword);
        if (envelope) data = await readData(account, envelope);
        material = account.material;
    } else {
        if (envelope) throw new Error('Las fichas anteriores necesitan su acceso original. Conserva los datos de este navegador.');
        if (legacy) {
            if (!previousPassword) return { accessUpdate: true };
            const previous = await unlockLegacy(previousPassword, legacy);
            data = { ...previous, validations: previous.validations ?? [] };
            recoveredLegacyRevision = legacy.revision;
        }
        material = {
            shared: encodeBytes(crypto.getRandomValues(new Uint8Array(32))),
            private: encodeBytes(crypto.getRandomValues(new Uint8Array(32)))
        };
    }
    const admin = await wrapSimpleAdmin(material);
    const { username, sharedKey, privateKey } = await authenticate({ admin }, 'admin', simpleAdminPassword);
    return { session: await saveVault({
        username, sharedKey, privateKey, revision: envelope?.revision ?? 0, recoveredLegacyRevision,
        canRecoverLegacy: Boolean(legacy && legacy.revision !== recoveredLegacyRevision), data
    }, data, legacy?.revision ?? 0, { expected: accounts, updated: { ...accounts, admin } }) };
}

export async function updateAdminAccess(previousPassword) {
    return installSimpleAdmin(previousPassword);
}

function finishSignIn({ original, material, ...account }) {
    if (!original.passwordChanged) return { passwordChange: { account, original, material } };
    return loadAccount(account);
}

export async function changeInitialPassword(pending, password) {
    if (password.length < 12 || password.length > 256) throw new Error('Usa una contraseña nueva de entre 12 y 256 caracteres.');
    const { account, original, material } = pending;
    const previousKey = await deriveKey(password, decodeBytes(original.salt));
    const same = await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: decodeBytes(original.iv), additionalData: encoder.encode('cuenta:' + account.username)
    }, previousKey, decodeBytes(original.ciphertext)).then(() => true, () => false);
    if (same) throw new Error('Elige una contraseña distinta de la temporal.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt);
    const wrapped = await encryptData(key, material, 'cuenta:' + account.username);
    const updated = { salt: encodeBytes(salt), iv: encodeBytes(wrapped.iv),
        ciphertext: encodeBytes(wrapped.ciphertext), passwordChanged: true };
    const db = await database();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const current = store.get(accessSlot);
        current.onsuccess = () => {
            if (current.result?.[account.username]?.ciphertext !== original.ciphertext) {
                tx.abort();
                return;
            }
            store.put({ ...current.result, [account.username]: updated }, accessSlot);
        };
        tx.oncomplete = resolve;
        tx.onabort = () => reject(new Error('No se pudo actualizar la contraseña. Vuelve a iniciar sesión.'));
    });
    return loadAccount(account);
}

async function readData(account, envelope) {
    const shared = await decryptData(account.sharedKey, envelope.shared, 'fichas:v2');
    const privateData = account.privateKey && envelope.private
        ? await decryptData(account.privateKey, envelope.private, 'administracion:v2') : null;
    return {
        version: 1,
        students: privateData ? shared.students.map((student) => ({
            ...student, ...privateData.financial?.[student.id]
        })) : shared.students,
        tutors: shared.tutors, folios: privateData?.folios ?? [],
        validations: (shared.validations ?? []).map((record) => ({
            ...record, ...privateData?.publications?.[record.id]
        }))
    };
}

async function loadAccount(account) {
    const [envelope, legacy] = await Promise.all([read(vaultSlot), read('vault')]);
    const recoveredLegacyRevision = envelope?.recoveredLegacyRevision ?? 0;
    const active = { ...account, recoveredLegacyRevision, canRecoverLegacy: Boolean(
        account.privateKey && legacy && legacy.revision !== recoveredLegacyRevision
    ) };
    if (envelope) {
        return { session: { ...active, revision: envelope.revision, data: await readData(account, envelope) } };
    }
    const data = emptyData();
    return { session: await saveVault({ ...active, revision: 0, data }, data, legacy?.revision ?? 0) };
}

function mergeRecovery(current, previous) {
    const students = new Map(current.students.map((student) => [student.id, student]));
    const studentIds = new Map();
    for (const student of previous.students) {
        const match = students.get(student.id) ?? current.students.find((entry) =>
            entry.name.toLocaleLowerCase('es') === student.name.toLocaleLowerCase('es') && entry.course === student.course
            && (!entry.rut || !student.rut || entry.rut === student.rut));
        const id = match?.id ?? student.id;
        studentIds.set(student.id, id);
        if (!match) students.set(id, student);
    }
    const tutors = new Map(previous.tutors.map((tutor) => [tutor.course, tutor]));
    for (const tutor of current.tutors) tutors.set(tutor.course, tutor);
    const merge = (active, old, key) => {
        const items = new Map(active.map((row) => [row[key], row]));
        for (const row of old) {
            if (studentIds.has(row.studentId) && !items.has(row[key])) {
                items.set(row[key], { ...row, studentId: studentIds.get(row.studentId) });
            }
        }
        return Array.from(items.values());
    };
    return { ...current, students: Array.from(students.values()), tutors: Array.from(tutors.values()),
        folios: merge(current.folios, previous.folios, 'code'),
        validations: merge(current.validations, previous.validations ?? [], 'id') };
}

export async function migrateLegacy(session, password) {
    if (!session.privateKey) throw new Error('La recuperación está disponible para Administración.');
    const legacy = await read('vault');
    if (!legacy) throw new Error('No hay fichas de la versión anterior en este navegador.');
    const data = await unlockLegacy(password, legacy);
    return saveVault({ ...session, recoveredLegacyRevision: legacy.revision, canRecoverLegacy: false },
        mergeRecovery(session.data, data), legacy.revision);
}

export async function exportEncryptedBackup(session) {
    if (!session.privateKey) throw new Error('El respaldo está disponible para Administración.');
    const envelope = await read(vaultSlot);
    const pack = (section) => section ? { iv: encodeBytes(section.iv), ciphertext: encodeBytes(section.ciphertext) } : null;
    return JSON.stringify({ format: 'student-finder-backup', version: 1,
        shared: pack(envelope.shared), private: pack(envelope.private) });
}

export async function restoreEncryptedBackup(session, file) {
    if (!session.privateKey) throw new Error('La restauración está disponible para Administración.');
    if (file.size > 32 * 1024 * 1024) throw new Error('El respaldo supera los 32 MB.');
    let backup;
    try {
        backup = JSON.parse(await file.text());
        if (backup?.format !== 'student-finder-backup' || backup.version !== 1) throw new Error();
    } catch {
        throw new Error('Selecciona un respaldo cifrado de Student Finder.');
    }
    const decode = (section) => section ? { iv: decodeBytes(section.iv), ciphertext: decodeBytes(section.ciphertext) } : null;
    const previous = await readData(session, { shared: decode(backup.shared), private: decode(backup.private) });
    return saveVault(session, mergeRecovery(session.data, previous));
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

export async function saveVault(session, data, expectedLegacyRevision, accountUpdate) {
    const admin = Boolean(session.privateKey);
    const revision = session.revision + 1;
    const submitted = admin ? data.students : withAcademicChanges(session.data.students, data.students);
    const students = submitted.map((student) => pick(student, ['id', 'name', 'course', 'given_names', 'family_names', ...academicFields]));
    const tutors = admin ? data.tutors : session.data.tutors;
    const studentIds = new Set(students.map(({ id }) => id));
    const existingIds = new Set(session.data.validations.map(({ id }) => id));
    const proposed = admin ? data.validations : [...session.data.validations,
        ...data.validations.filter(({ id }) => !existingIds.has(id))];
    const validations = proposed.filter(({ studentId }) => studentIds.has(studentId)).map((record) => pick(record, validationFields));
    const shared = await encryptData(session.sharedKey, { students, tutors, validations }, 'fichas:v2');
    const privateData = admin ? {
        financial: Object.fromEntries(submitted.map((record) => [record.id, pick(record, privateFields)])),
        folios: data.folios,
        publications: Object.fromEntries(data.validations.filter(({ studentId }) => studentIds.has(studentId))
            .map(({ id, published, publicCode }) => [id, { published: Boolean(published), publicCode: publicCode ?? '' }]))
    } : null;
    const sealedPrivate = admin ? await encryptData(session.privateKey, privateData, 'administracion:v2') : null;
    const authorized = admin ? [...data.folios.filter((folio) => folio.published),
        ...data.validations.filter((record) => record.published && record.publicCode && studentIds.has(record.studentId))] : [];
    const published = await Promise.all(authorized.map(async (folio) => [
        await codeHash(folio.publicCode || folio.code),
        { annulled: folio.annulled, state: folio.state, expiresOn: folio.expiresOn }
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
            const commit = () => {
                store.put({ shared, private: admin ? sealedPrivate : current.result?.private ?? null, revision,
                    recoveredLegacyRevision: session.recoveredLegacyRevision }, vaultSlot);
                if (admin) store.put(Object.fromEntries(published), publicSlot);
                if (accountUpdate) store.put(accountUpdate.updated, accessSlot);
            };
            const write = () => {
                if (!accountUpdate) {
                    commit();
                    return;
                }
                const access = store.get(accessSlot);
                access.onsuccess = () => {
                    if (JSON.stringify(access.result ?? null) === JSON.stringify(accountUpdate.expected)) commit();
                    else {
                        changed = true;
                        tx.abort();
                    }
                };
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
    return { ...session, revision, data: admin ? data : { version: 1, students, tutors, folios: [], validations } };
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
    if (folio.annulled || folio.state === 'anulado') return 'anulado';
    if (folio.state === 'vencido' || (folio.expiresOn && folio.expiresOn < today)) return 'vencido';
    return 'vigente';
}

export async function validateCode(value) {
    const code = value.trim().toLowerCase().replaceAll('-', '');
    if (!/^[0-9a-f]{32}$/.test(code)) throw new Error('Ingresa un folio completo de 32 caracteres.');
    const catalog = await read(publicSlot);
    return folioStatus(catalog?.[await codeHash(code)]);
}
