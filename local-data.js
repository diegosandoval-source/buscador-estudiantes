const databaseName = 'buscador-estudiantes-local-v1';
const storeName = 'data';
const vaultSlot = 'vault-v2';
const publicSlot = 'public';
const accessSlot = 'access-v2';
const simpleAccessSlot = 'simple-access-v1';
const simpleVaultSlot = 'simple-vault-v1';
const simplePublicSlot = 'simple-public-v1';
const simpleAdminPassword = '1234';
const managedAccessSlot = 'accounts-v3';
const temporarySlot = 'temporary-passwords-v3';
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
    return { version: 1, students: [], tutors: [], folios: [], validations: [],
        referenceStudents: [], referenceMeta: null, comparisons: [], comparisonHistory: [], audit: [] };
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
    const bundle = await managedAccounts();
    const stored = bundle.accounts[username];
    if (!stored?.active) throw new Error('Usuario o contraseña incorrectos, o cuenta desactivada.');
    const account = await authenticate(bundle.accounts, username, password);
    const managed = {
        ...account, userId: stored.id, role: stored.role, managed: true,
        authCiphertext: stored.ciphertext, vaultSlot: bundle.vaultSlot, publicSlot: bundle.publicSlot,
        adminMaterial: stored.role === 'admin' ? account.material : null
    };
    if (stored.role !== 'admin') managed.privateKey = null;
    const result = await finishSignIn(managed);
    if (result.session) await checkSession(result.session);
    return result;
}

async function wrapAccount(username, password, material) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const wrapped = await encryptData(await deriveKey(password, salt), material, 'cuenta:' + username);
    return { salt: encodeBytes(salt), iv: encodeBytes(wrapped.iv), ciphertext: encodeBytes(wrapped.ciphertext) };
}

function temporaryPassword() {
    return encodeBytes(crypto.getRandomValues(new Uint8Array(18))).replaceAll('+', '-').replaceAll('/', '_');
}

async function managedAccounts() {
    const current = await read(managedAccessSlot);
    if (current) return current;
    const [simple, previous] = await Promise.all([read(simpleAccessSlot), read(accessSlot)]);
    const existing = simple ?? (previous?.admin?.simpleAccess ? previous : null);
    const sourceSlot = simple ? simpleAccessSlot : existing ? accessSlot : null;
    const material = existing ? (await authenticate(existing, 'admin', simpleAdminPassword)).material : {
        shared: encodeBytes(crypto.getRandomValues(new Uint8Array(32))),
        private: encodeBytes(crypto.getRandomValues(new Uint8Array(32)))
    };
    const consultationPassword = temporaryPassword();
    const initial = [
        ['admin', '0246', 'admin'], ['enfermeria', '1234', 'consulta'], ['consulta', consultationPassword, 'consulta']
    ];
    const accounts = {};
    for (const [username, password, role] of initial) {
        accounts[username] = { ...await wrapAccount(username, password, role === 'admin' ? material : { shared: material.shared }),
            id: crypto.randomUUID(), role, active: true, passwordChanged: false };
    }
    const bundle = { version: 3, revision: 1, accounts,
        vaultSlot: !simple && existing ? vaultSlot : simpleVaultSlot,
        publicSlot: !simple && existing ? publicSlot : simplePublicSlot };
    const secrets = await encryptData(await importDataKey(material.private), {
        admin: '0246', enfermeria: '1234', consulta: consultationPassword
    }, 'cuentas:temporales:v3');
    const db = await database();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.get(managedAccessSlot);
        request.onsuccess = () => {
            if (request.result) return;
            const commit = () => {
                store.put(bundle, managedAccessSlot);
                store.put(secrets, temporarySlot);
                if (sourceSlot) store.delete(sourceSlot);
            };
            if (!sourceSlot) { commit(); return; }
            const source = store.get(sourceSlot);
            source.onsuccess = () => {
                if (source.result?.admin?.ciphertext !== existing.admin.ciphertext) tx.abort();
                else commit();
            };
        };
        tx.oncomplete = resolve;
        tx.onabort = () => reject(new Error('No se pudieron preparar las cuentas de este navegador.'));
    });
    return read(managedAccessSlot);
}

function currentUser(bundle, session) {
    const user = bundle?.accounts?.[session.username];
    return user && user.active && user.id === session.userId && user.ciphertext === session.authCiphertext
        && user.role === session.role ? user : null;
}

export async function checkSession(session, admin = false) {
    const bundle = await read(managedAccessSlot);
    if (bundle && (!session.managed || !currentUser(bundle, session))) {
        throw new Error('Tu acceso cambió o fue desactivado. Vuelve a iniciar sesión.');
    }
    if (admin && (!session.privateKey || session.role === 'consulta')) {
        throw new Error('Tu cuenta es de solo lectura. Esta operación requiere Administración.');
    }
    return bundle;
}

export async function refreshSession(session) {
    await checkSession(session);
    const envelope = await read(session.vaultSlot ?? vaultSlot);
    if (!envelope || envelope.revision === session.revision) return session;
    return { ...session, revision: envelope.revision, data: await readData(session, envelope) };
}

export async function listUsers(session) {
    const bundle = await checkSession(session, true);
    const secrets = await decryptData(session.privateKey, await read(temporarySlot), 'cuentas:temporales:v3');
    return Object.entries(bundle.accounts).map(([username, user]) => ({
        id: user.id, username, role: user.role, active: user.active, needsPassword: !user.passwordChanged,
        temporaryPassword: user.passwordChanged ? '' : secrets[username] ?? ''
    })).sort((a, b) => a.username.localeCompare(b.username, 'es'));
}

export async function manageUser(session, changes) {
    const bundle = await checkSession(session, true);
    const username = String(changes.username ?? '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_.-]{2,31}$/.test(username)) throw new Error('Usa un nombre de usuario de 3 a 32 caracteres.');
    if (!['admin', 'consulta'].includes(changes.role)) throw new Error('Selecciona un rol válido.');
    const found = Object.entries(bundle.accounts).find(([, user]) => user.id === changes.id);
    const previousName = found?.[0];
    const previous = found?.[1];
    if (changes.id && !previous) throw new Error('La cuenta ya no está disponible.');
    if (Object.hasOwn(bundle.accounts, username) && username !== previousName) throw new Error('Ese nombre de usuario ya está ocupado.');
    if (previous?.id === session.userId && (username !== previousName || changes.role !== 'admin'
        || changes.active === false || changes.reset)) {
        throw new Error('Otra cuenta administradora debe cambiar tu propio acceso.');
    }
    const reset = !previous || changes.reset || username !== previousName || changes.role !== previous.role;
    const password = reset ? temporaryPassword() : '';
    const wrapped = reset ? await wrapAccount(username, password, changes.role === 'admin'
        ? session.adminMaterial : { shared: session.adminMaterial.shared }) : previous;
    const user = { ...wrapped, id: previous?.id ?? crypto.randomUUID(), role: changes.role,
        active: changes.active !== false, passwordChanged: reset ? false : previous.passwordChanged };
    const accounts = { ...bundle.accounts };
    if (previousName) delete accounts[previousName];
    accounts[username] = user;
    if (!Object.values(accounts).some((entry) => entry.active && entry.role === 'admin')) {
        throw new Error('Debe quedar al menos una cuenta administradora activa.');
    }
    const secrets = await decryptData(session.privateKey, await read(temporarySlot), 'cuentas:temporales:v3');
    if (previousName && previousName !== username) delete secrets[previousName];
    if (password) secrets[username] = password;
    const sealedSecrets = await encryptData(session.privateKey, secrets, 'cuentas:temporales:v3');
    const audit = [...(session.data.audit ?? []), {
        id: crypto.randomUUID(), at: new Date().toISOString(), actor: session.username,
        action: previous ? reset ? 'cuenta.restablecer' : 'cuenta.actualizar' : 'cuenta.crear',
        subject: username, details: { role: user.role, active: user.active }
    }];
    const next = await saveVault(session, { ...session.data, audit }, undefined, {
        slot: managedAccessSlot, expected: bundle, updated: { ...bundle, accounts, revision: bundle.revision + 1 },
        secrets: sealedSecrets
    });
    return { session: next, username, password };
}

async function openSimpleAdmin() {
    const accounts = await read(simpleAccessSlot);
    if (accounts) {
        const { username, sharedKey, privateKey } = await authenticate(accounts, 'admin', simpleAdminPassword);
        return loadAccount({ username, sharedKey, privateKey, vaultSlot: simpleVaultSlot, publicSlot: simplePublicSlot });
    }
    const material = {
        shared: encodeBytes(crypto.getRandomValues(new Uint8Array(32))),
        private: encodeBytes(crypto.getRandomValues(new Uint8Array(32)))
    };
    const admin = await wrapSimpleAdmin(material);
    const { username, sharedKey, privateKey } = await authenticate({ admin }, 'admin', simpleAdminPassword);
    const data = emptyData();
    return { session: await saveVault({
        username, sharedKey, privateKey, vaultSlot: simpleVaultSlot, publicSlot: simplePublicSlot,
        revision: 0, recoveredLegacyRevision: 0, canRecoverLegacy: false, data
    }, data, undefined, { slot: simpleAccessSlot, expected: null, updated: { admin } }) };
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
    const updated = { ...original, salt: encodeBytes(salt), iv: encodeBytes(wrapped.iv),
        ciphertext: encodeBytes(wrapped.ciphertext), passwordChanged: true };
    const db = await database();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const slot = account.managed ? managedAccessSlot : accessSlot;
        const current = store.get(slot);
        current.onsuccess = () => {
            const accounts = account.managed ? current.result?.accounts : current.result;
            if (accounts?.[account.username]?.ciphertext !== original.ciphertext
                || account.managed && !accounts[account.username].active) {
                tx.abort();
                return;
            }
            const changed = { ...accounts, [account.username]: updated };
            store.put(account.managed ? { ...current.result, accounts: changed, revision: current.result.revision + 1 } : changed, slot);
        };
        tx.oncomplete = resolve;
        tx.onabort = () => reject(new Error('No se pudo actualizar la contraseña. Vuelve a iniciar sesión.'));
    });
    return loadAccount({ ...account, authCiphertext: updated.ciphertext });
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
        })),
        referenceStudents: privateData?.referenceStudents ?? [], referenceMeta: shared.referenceMeta ?? null,
        comparisons: (shared.comparisons ?? []).map((record) => ({
            ...record, fields: record.fields.map((field) => field.key === 'rut' && privateData?.comparisonRuts?.[record.id]
                ? { ...field, ...privateData.comparisonRuts[record.id] } : field)
        })),
        comparisonHistory: privateData?.comparisonHistory ?? [], audit: privateData?.audit ?? []
    };
}

async function loadAccount(account) {
    await checkSession(account);
    const [envelope, legacy] = await Promise.all([read(account.vaultSlot ?? vaultSlot), read('vault')]);
    const recoveredLegacyRevision = envelope?.recoveredLegacyRevision ?? 0;
    const active = { ...account, recoveredLegacyRevision, canRecoverLegacy: Boolean(
        !account.vaultSlot && account.privateKey && legacy && legacy.revision !== recoveredLegacyRevision
    ) };
    if (envelope) {
        return { session: { ...active, revision: envelope.revision, data: await readData(account, envelope) } };
    }
    const data = emptyData();
    if (!account.privateKey) return { session: { ...active, revision: 0, data } };
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
    await checkSession(session, true);
    if (!session.privateKey) throw new Error('El respaldo está disponible para Administración.');
    const envelope = await read(session.vaultSlot ?? vaultSlot);
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

export async function saveVault(session, data, expectedLegacyRevision, accountUpdate) {
    await checkSession(session, true);
    const admin = Boolean(session.privateKey);
    const storageSlot = session.vaultSlot ?? vaultSlot;
    const publicationSlot = session.publicSlot ?? publicSlot;
    const revision = session.revision + 1;
    const submitted = data.students;
    const students = submitted.map((student) => pick(student, [
        'id', 'name', 'course', 'given_names', 'family_names', 'tutor', 'sourceConflict', 'sourceRow', ...academicFields
    ]));
    const tutors = data.tutors;
    const studentIds = new Set(students.map(({ id }) => id));
    const proposed = data.validations;
    const validations = proposed.filter(({ studentId }) => studentIds.has(studentId)).map((record) => pick(record, validationFields));
    const comparisons = (data.comparisons ?? []).filter(({ studentId }) => studentIds.has(studentId));
    const sharedComparisons = comparisons.map((record) => ({
        ...record, fields: record.fields.map((field) => field.key === 'rut' ? {
            ...field, reference: field.reference ? 'Informado' : 'Sin dato',
            submitted: field.reference && field.submitted ? field.different ? 'Diferente' : 'Coincide' : 'Sin dato'
        } : field)
    }));
    const shared = await encryptData(session.sharedKey, {
        students, tutors, validations, comparisons: sharedComparisons, referenceMeta: data.referenceMeta ?? null
    }, 'fichas:v2');
    const privateData = admin ? {
        financial: Object.fromEntries(submitted.map((record) => [record.id, {
            ...pick(record, privateFields), ...(Object.hasOwn(record, 'comparisonRut') ? { comparisonRut: record.comparisonRut } : {})
        }])),
        folios: data.folios,
        referenceStudents: data.referenceStudents ?? [], comparisonHistory: data.comparisonHistory ?? [], audit: data.audit ?? [],
        comparisonRuts: Object.fromEntries(comparisons.map((record) => [
            record.id, record.fields.find((field) => field.key === 'rut')
        ])),
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
        const current = store.get(storageSlot);
        let changed = false;
        let denied = false;
        current.onsuccess = () => {
            if ((current.result?.revision ?? 0) !== session.revision) {
                changed = true;
                tx.abort();
                return;
            }
            const commitWrites = () => {
                store.put({ shared, private: admin ? sealedPrivate : current.result?.private ?? null, revision,
                    recoveredLegacyRevision: session.recoveredLegacyRevision }, storageSlot);
                if (admin) store.put(Object.fromEntries(published), publicationSlot);
                if (accountUpdate) store.put(accountUpdate.updated, accountUpdate.slot ?? accessSlot);
                if (accountUpdate?.secrets) store.put(accountUpdate.secrets, temporarySlot);
            };
            const commit = () => {
                const access = store.get(managedAccessSlot);
                access.onsuccess = () => {
                    if (access.result && (!currentUser(access.result, session) || session.role !== 'admin')) {
                        denied = true;
                        tx.abort();
                    } else commitWrites();
                };
            };
            const write = () => {
                if (!accountUpdate) {
                    commit();
                    return;
                }
                const access = store.get(accountUpdate.slot ?? accessSlot);
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
        tx.onabort = () => reject(new Error(denied ? 'Tu acceso cambió. Vuelve a iniciar sesión.' : changed
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
    const [catalog, simpleCatalog] = await Promise.all([read(publicSlot), read(simplePublicSlot)]);
    const hash = await codeHash(code);
    return folioStatus(simpleCatalog?.[hash] ?? catalog?.[hash]);
}
