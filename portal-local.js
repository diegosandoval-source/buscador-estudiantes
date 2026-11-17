import { activateAccount, changeInitialPassword, exportEncryptedBackup, folioStatus, hasAccessFile, migrateLegacy, newCode,
    openAccount, restoreEncryptedBackup, saveVault, todayInChile, validateCode } from './local-data.js?v=8';
import { normalizeCourse, normalized, readRoster } from './student-import.js?v=8';
import { displayRut, normalizeRut, resolveStudent, studentMatches, validationFromForm, validationLabels } from './validation-records.js?v=8';

const get = (id) => document.getElementById(id);
const login = get('login');
const accessForm = get('access-form');
const accessDialog = get('access-dialog');
const passwordForm = get('password-change');
const passwordDialog = get('password-dialog');
const recordForm = get('record-form');
const recordDialog = get('record-dialog');
const backupFile = get('backup-file');
const migrationForm = get('migration');
const migrationDialog = get('migration-dialog');
const studentForm = get('student-form');
const importFile = get('import-file');
const importButton = get('open-import');
const folioForm = get('folio-form');
const validationForm = get('validation');
const search = get('search');
const studentDialog = get('student-dialog');
const folioDialog = get('folio-dialog');
const validationDialog = get('validation-dialog');
const fields = ['name', 'phone', 'email'];
const statusText = {
    vigente: 'Vigente', vencido: 'Vencido', anulado: 'Anulado', no_existe: 'No se encontró un folio autorizado.'
};

let session;
let activating = false;
let pendingPasswordChange;
let changingPassword = false;
let migrating = false;
let saving = false;
let selected;
let editing;
let editingFolio;
let recordStudentId;
let recordValidationId;
const rememberedUserKey = 'student-finder-remembered-user';

function text(tag, value) {
    const node = document.createElement(tag);
    node.textContent = value;
    return node;
}

function action(label, callback) {
    const button = text('button', label);
    button.type = 'button';
    button.className = 'button secondary';
    button.addEventListener('click', callback);
    return button;
}

function showMessage(id, message) {
    get(id).textContent = message;
}

function handleSubmit(form, statusId, handler) {
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = form.querySelector('[type="submit"]');
        if (button.disabled) return;
        button.disabled = true;
        showMessage(statusId, '');
        try { await handler(); }
        catch (error) { showMessage(statusId, error.message || 'No se pudo completar la operación.'); }
        finally { button.disabled = false; }
    });
}

function configureLogin() {
    if (!globalThis.crypto?.subtle || !globalThis.indexedDB) {
        showMessage('login-status', 'Abre esta página en un navegador actualizado mediante HTTPS.');
        return;
    }
    try {
        const remembered = localStorage.getItem(rememberedUserKey);
        login.elements.username.value = remembered ?? login.elements.username.value;
        login.elements.remember.checked = Boolean(remembered);
    } catch { /* El acceso funciona sin preferencias guardadas. */ }
    get('enter').disabled = false;
}

get('reveal').addEventListener('click', () => {
    const show = login.elements.password.type === 'password';
    login.elements.password.type = show ? 'text' : 'password';
    get('reveal').setAttribute('aria-pressed', String(show));
    get('reveal').textContent = show ? 'Ocultar contraseña' : 'Mostrar contraseña';
});

function isAdmin() {
    return Boolean(session?.privateKey);
}

function openWorkspace(nextSession) {
    session = nextSession;
    const admin = isAdmin();
    get('entry').hidden = true;
    get('workspace').hidden = false;
    get('logout').hidden = false;
    get('load-data').hidden = false;
    get('connected-user').hidden = false;
    for (const id of ['admin-folios', 'make-folio', 'remove-student', 'open-import', 'admin-backups']) get(id).hidden = !admin;
    get('recover-legacy').hidden = !nextSession.canRecoverLegacy;
    showMessage('role-label', admin ? 'Administración' : 'Enfermería');
    showMessage('connected-user', nextSession.username);
    showMessage('welcome-message', admin ? 'Hola, Administrador. Has iniciado sesión correctamente.' : 'Hola, Enfermería. Has iniciado sesión correctamente.');
    showMessage('search-label', admin ? 'Nombre, apellido, RUT, curso o folio' : 'Nombre, apellido, curso o folio');
    try {
        if (login.elements.remember.checked) localStorage.setItem(rememberedUserKey, nextSession.username);
        else localStorage.removeItem(rememberedUserKey);
    } catch { /* El acceso funciona sin preferencias guardadas. */ }
    render();
    search.focus();
}

function clearLoginPassword() {
    login.elements.password.value = '';
    if (login.elements.password.type === 'text') get('reveal').click();
}

function completeLogin(result) {
    if (result.passwordChange) {
        pendingPasswordChange = result.passwordChange;
        passwordForm.reset();
        showMessage('password-status', '');
        passwordDialog.showModal();
        return;
    }
    openWorkspace(result.session);
}

function credentials() {
    return [login.elements.username.value.trim().toLowerCase(), login.elements.password.value];
}

handleSubmit(login, 'login-status', async () => {
    if (!await hasAccessFile()) {
        accessForm.reset();
        showMessage('access-status', '');
        accessDialog.showModal();
        return;
    }
    const account = credentials();
    clearLoginPassword();
    completeLogin(await openAccount(...account));
});

accessDialog.addEventListener('close', () => {
    accessForm.reset();
    clearLoginPassword();
});
accessDialog.addEventListener('cancel', (event) => {
    if (activating) event.preventDefault();
});

handleSubmit(accessForm, 'access-status', async () => {
    const file = accessForm.elements.file.files[0];
    if (!file) throw new Error('Selecciona el Excel de accesos.');
    const back = accessForm.querySelector('.close');
    activating = true;
    back.disabled = true;
    try {
        const result = await activateAccount(file, ...credentials());
        accessDialog.close();
        completeLogin(result);
    } catch (error) {
        if (!await hasAccessFile()) throw error;
        accessDialog.close();
        showMessage('login-status', error.message);
    } finally {
        activating = false;
        back.disabled = false;
    }
});

passwordDialog.addEventListener('close', () => {
    pendingPasswordChange = null;
    passwordForm.reset();
});
passwordDialog.addEventListener('cancel', (event) => {
    if (changingPassword) event.preventDefault();
});

handleSubmit(passwordForm, 'password-status', async () => {
    if (!pendingPasswordChange) return;
    const password = passwordForm.elements.password.value;
    if (password !== passwordForm.elements.confirmation.value) throw new Error('Las contraseñas no coinciden.');
    const back = passwordForm.querySelector('.close');
    changingPassword = true;
    back.disabled = true;
    try {
        const result = await changeInitialPassword(pendingPasswordChange, password);
        passwordDialog.close();
        completeLogin(result);
    } finally {
        changingPassword = false;
        back.disabled = false;
    }
});

get('recover-legacy').addEventListener('click', () => {
    if (!isAdmin() || !session.canRecoverLegacy || saving) return;
    showMessage('migration-status', '');
    migrationDialog.showModal();
});
migrationDialog.addEventListener('close', () => {
    migrationForm.reset();
});
migrationDialog.addEventListener('cancel', (event) => {
    if (migrating) event.preventDefault();
});

handleSubmit(migrationForm, 'migration-status', async () => {
    if (!isAdmin() || !session.canRecoverLegacy || saving) return;
    migrating = true;
    const back = migrationForm.querySelector('.close');
    back.disabled = true;
    try {
        session = await migrateLegacy(session, migrationForm.elements.previousPassword.value);
        migrationDialog.close();
        get('recover-legacy').hidden = true;
        render();
        showMessage('workspace-status', 'Se recuperaron las fichas y los folios anteriores.');
    } finally {
        back.disabled = false;
        migrating = false;
    }
});

get('logout').addEventListener('click', () => {
    if (saving) return;
    session = null;
    selected = null;
    editing = null;
    editingFolio = null;
    recordStudentId = null;
    recordValidationId = null;
    importFile.value = '';
    studentForm.reset();
    folioForm.reset();
    recordForm.reset();
    validationForm.reset();
    login.reset();
    search.value = '';
    for (const id of ['results', 'contact-cards', 'folio-list', 'student-history']) get(id).replaceChildren();
    for (const id of ['student-name', 'student-course', 'student-rut', 'connected-user', 'search-status', 'workspace-status',
        'import-status', 'import-notes', 'student-status', 'folio-status', 'validation-status', 'backup-status']) showMessage(id, '');
    get('folio-code').value = '';
    get('folio-result').hidden = true;
    for (const dialog of [studentDialog, folioDialog, validationDialog, recordDialog]) if (dialog.open) dialog.close();
    get('student-card').hidden = true;
    get('workspace').hidden = true;
    get('logout').hidden = true;
    get('connected-user').hidden = true;
    get('load-data').hidden = true;
    get('entry').hidden = false;
    get('enter').disabled = true;
    configureLogin();
    login.elements.username.focus();
});

async function persist(data) {
    if (!session || saving) throw new Error('Espera a que termine la operación anterior.');
    saving = true;
    get('logout').disabled = true;
    try { session = await saveVault(session, data); }
    finally {
        saving = false;
        get('logout').disabled = false;
    }
}

function histories() {
    const byStudent = new Map();
    const legacy = session.data.folios.map((folio) => ({ ...folio, type: 'Folio de validación', legacy: true }));
    for (const record of [...session.data.validations, ...legacy]) {
        if (!byStudent.has(record.studentId)) byStudent.set(record.studentId, []);
        byStudent.get(record.studentId).push(record);
    }
    return byStudent;
}

function asResult(record, history) {
    const item = document.createElement('li');
    const description = document.createElement('div');
    description.className = 'result-line';
    const states = [...new Set(history.map((entry) => validationLabels[folioStatus(entry)]))];
    const detail = [record.course, isAdmin() && record.rut ? 'RUT ' + displayRut(record.rut) : '',
        `${history.length} ${history.length === 1 ? 'validación' : 'validaciones'}`, ...states].filter(Boolean).join(' · ');
    description.append(text('strong', record.name), text('span', detail));
    item.append(description,
        action('Ver detalle', () => {
            selected = record.id;
            renderStudent();
            get('student-card').scrollIntoView({ block: 'nearest' });
        }));
    return item;
}

function renderResults() {
    if (!session) return;
    const byStudent = histories();
    const matches = session.data.students.filter((record) => studentMatches(record, byStudent.get(record.id) ?? [], search.value));
    matches.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    get('results').replaceChildren(...matches.slice(0, 30).map((record) => asResult(record, byStudent.get(record.id) ?? [])));
    get('empty-results').hidden = Boolean(session.data.students.length);
    const count = `${matches.length} ${matches.length === 1 ? 'resultado encontrado' : 'resultados encontrados'}`;
    showMessage('search-status', matches.length > 30 ? `${count}. Se muestran 30.` : count);
}

function selectedStudent() {
    return session?.data.students.find((record) => record.id === selected);
}

function historyItem(record) {
    const item = document.createElement('li');
    const content = document.createElement('div');
    content.className = 'validation-detail';
    content.append(text('strong', record.type), text('p', [record.code, validationLabels[folioStatus(record)]].join(' · ')));
    const dates = [record.issuedOn && 'Emisión ' + record.issuedOn, record.expiresOn && 'Vence ' + record.expiresOn].filter(Boolean);
    if (dates.length) content.append(text('p', dates.join(' · ')));
    if (record.notes) content.append(text('p', record.notes));
    item.append(content);
    if (isAdmin()) {
        const actions = document.createElement('div');
        actions.className = 'actions';
        if (record.published && record.publicCode) {
            actions.append(action('Copiar código público', () => copy(record.publicCode, 'workspace-status')));
        }
        actions.append(action('Editar', () => record.legacy ? openFolio(record) : openRecord(selectedStudent(), record)));
        if (!record.legacy) actions.append(action('Eliminar', () => removeValidation(record)));
        item.append(actions);
    }
    return item;
}

function contacts(record) {
    const tutor = session.data.tutors.find((item) => item.course === record.course);
    const items = [
        ['Profesor tutor', [tutor?.name, tutor?.email]],
        ['Apoderado académico', [record.academic_name, record.academic_phone, record.academic_email]]
    ];
    if (isAdmin()) items.push(['Apoderado de cuentas', [record.financial_name, record.financial_phone, record.financial_email]]);
    return items;
}

function renderStudent() {
    const record = selectedStudent();
    get('student-card').hidden = !record;
    showMessage('student-name', record?.name ?? '');
    showMessage('student-course', record?.course ?? '');
    get('student-rut').hidden = !isAdmin() || !record?.rut;
    showMessage('student-rut', record?.rut && isAdmin() ? 'RUT ' + displayRut(record.rut) : '');
    const cards = record ? contacts(record).map(([label, entries]) => {
        const section = document.createElement('section');
        const lines = entries.filter(Boolean);
        section.append(text('h3', label), ...(lines.length ? lines : ['Sin registrar']).map((line) => text('p', line)));
        return section;
    }) : [];
    get('contact-cards').replaceChildren(...cards);
    const history = record ? (histories().get(record.id) ?? []).slice().reverse() : [];
    get('student-history').replaceChildren(...(history.length ? history.map(historyItem) : [text('li', 'Aún no hay validaciones registradas.')]));
}

function renderFolios() {
    if (!isAdmin()) {
        get('folio-list').replaceChildren();
        return;
    }
    const names = new Map(session.data.students.map((record) => [record.id, record.name]));
    const items = session.data.folios.slice().reverse().map((folio) => {
        const item = document.createElement('li');
        const label = `${names.get(folio.studentId)} · ${folio.published ? statusText[folioStatus(folio)] : 'Privado'}`;
        item.append(text('span', label), action('Abrir folio', () => openFolio(folio)));
        return item;
    });
    get('folio-list').replaceChildren(...(items.length ? items : [text('li', 'Todavía no hay folios.')]));
}

function render() {
    renderResults();
    renderStudent();
    renderFolios();
}

search.addEventListener('input', renderResults);

function syncContacts() {
    const same = get('same-contact').checked;
    for (const field of fields) {
        const financial = studentForm.elements['financial_' + field];
        financial.readOnly = same;
        if (same) financial.value = studentForm.elements['academic_' + field].value;
    }
}

function openStudent(record) {
    editing = record?.id;
    studentForm.reset();
    const canEditIdentity = isAdmin() || !record;
    studentForm.elements.name.readOnly = !canEditIdentity;
    studentForm.elements.course.readOnly = !canEditIdentity;
    get('financial-fields').hidden = !isAdmin();
    get('financial-fields').disabled = !isAdmin();
    get('student-rut-input').hidden = !isAdmin();
    studentForm.elements.rut.disabled = !isAdmin();
    showMessage('student-status', '');
    if (record) {
        for (const input of studentForm.querySelectorAll('input[name]')) {
            input.value = record[input.name] || '';
        }
    }
    syncContacts();
    studentDialog.showModal();
}

get('new-student').addEventListener('click', () => openStudent());
get('edit-student').addEventListener('click', () => openStudent(selectedStudent()));
get('same-contact').addEventListener('change', syncContacts);
for (const field of fields) studentForm.elements['academic_' + field].addEventListener('input', syncContacts);

handleSubmit(studentForm, 'student-status', async () => {
    const record = Object.fromEntries(Array.from(new FormData(studentForm), ([key, value]) => [key, value.trim()]));
    record.course = normalizeCourse(record.course);
    if (!record.name) throw new Error('Completa el nombre.');
    if (isAdmin()) {
        record.rut = normalizeRut(record.rut);
        if (record.rut && !/^\d{1,8}[\dK]$/.test(record.rut)) throw new Error('Revisa el formato del RUT.');
        if (record.rut && session.data.students.some((item) => item.id !== editing && normalizeRut(item.rut) === record.rut)) {
            throw new Error('Ya existe una ficha con este RUT.');
        }
    }
    record.id = editing ?? crypto.randomUUID();
    const old = session.data;
    const students = editing ? old.students.map((item) => item.id === editing ? { ...item, ...record } : item) : [...old.students, record];
    await persist({ ...old, students });
    selected = record.id;
    studentDialog.close();
    render();
    showMessage('workspace-status', 'Ficha guardada.');
});

get('remove-student').addEventListener('click', async () => {
    const record = selectedStudent();
    if (!record || !isAdmin() || !confirm('¿Eliminar esta ficha y sus folios en este navegador?')) return;
    try {
        const old = session.data;
        await persist({ ...old,
            students: old.students.filter((item) => item.id !== record.id),
            folios: old.folios.filter((folio) => folio.studentId !== record.id),
            validations: old.validations.filter((validation) => validation.studentId !== record.id)
        });
        selected = null;
        render();
        showMessage('workspace-status', 'Ficha eliminada.');
    } catch (error) { showMessage('workspace-status', error.message); }
});

async function copy(value, status) {
    try {
        await navigator.clipboard.writeText(value);
        showMessage(status, 'Copiado.');
    } catch {
        showMessage(status, 'El navegador no permitió copiar.');
    }
}

get('copy-student').addEventListener('click', () => {
    const record = selectedStudent();
    if (record) copy([record.name, record.course, isAdmin() ? displayRut(record.rut) : '', ...contacts(record).flatMap(([label, values]) =>
        [label, ...values.filter(Boolean)])].join('\n'), 'workspace-status');
});

function openRecord(student = null, record = null) {
    if (!session || (record && !isAdmin())) return;
    recordStudentId = student?.id ?? '';
    recordValidationId = record?.id ?? '';
    recordForm.reset();
    get('record-person').hidden = Boolean(student);
    get('record-person').disabled = Boolean(student);
    get('record-student').hidden = !student;
    showMessage('record-student', student ? [student.name, student.course].filter(Boolean).join(' · ') : '');
    get('record-rut').hidden = !isAdmin();
    recordForm.elements.rut.disabled = !isAdmin();
    get('publish-validation').hidden = !isAdmin();
    recordForm.elements.published.disabled = !isAdmin();
    showMessage('record-title', record ? 'Editar validación' : 'Cargar datos');
    showMessage('record-status', '');
    recordForm.elements.issuedOn.value = record?.issuedOn || todayInChile();
    for (const key of ['code', 'type', 'expiresOn', 'state', 'notes']) {
        if (record) recordForm.elements[key].value = record[key] ?? '';
    }
    recordForm.elements.published.checked = Boolean(record?.published);
    recordDialog.showModal();
}

get('load-data').addEventListener('click', () => openRecord());
get('add-validation').addEventListener('click', () => { if (selectedStudent()) openRecord(selectedStudent()); });

handleSubmit(recordForm, 'record-status', async () => {
    if (!session) return;
    const before = session.data;
    const fields = Object.fromEntries(new FormData(recordForm));
    const previous = before.validations.find((record) => record.id === recordValidationId);
    if (recordValidationId && (!previous || !isAdmin())) throw new Error('La validación ya no está disponible para editar.');
    const student = resolveStudent(before.students, fields, recordStudentId);
    const entry = validationFromForm(fields, student.id, previous, isAdmin(), newCode);
    const alreadyUsed = [...before.validations, ...before.folios].some((item) =>
        (!previous || item.id !== previous.id) && normalized(item.code) === normalized(entry.code));
    if (alreadyUsed) throw new Error('Ese código ya pertenece a una validación. Usa otro código.');
    let students = before.students;
    if (!students.some(({ id }) => id === student.id)) students = [...students, student];
    else if (isAdmin() && !student.rut && fields.rut) {
        students = students.map((item) => item.id === student.id ? { ...item, rut: normalizeRut(fields.rut) } : item);
    }
    const validations = previous ? before.validations.map((item) => item.id === previous.id ? entry : item)
        : [...before.validations, entry];
    await persist({ ...before, students, validations });
    recordDialog.close();
    search.value = '';
    selected = student.id;
    render();
    showMessage('workspace-status', 'Validación guardada.');
    search.focus();
});

async function removeValidation(record) {
    if (!isAdmin() || !confirm('¿Eliminar esta validación y retirar su consulta externa?')) return;
    try {
        const old = session.data;
        await persist({ ...old, validations: old.validations.filter(({ id }) => id !== record.id) });
        render();
        showMessage('workspace-status', 'Validación eliminada.');
    } catch (error) { showMessage('workspace-status', error.message); }
}

function studentKey(record) {
    return normalized(record.name) + '\u0000' + normalized(record.course);
}

export function reviewRoster(roster, saved) {
    const seen = new Set(saved.students.map(studentKey));
    const ruts = new Set(saved.students.map((record) => normalizeRut(record.rut)).filter(Boolean));
    const students = [];
    let invalid = 0;
    let duplicates = 0;
    let questionableEmails = 0;
    for (const record of roster.students) {
        if (!record.name || !record.course || record.name.length > 200 || record.course.length > 80) {
            invalid++;
            continue;
        }
        const key = studentKey(record);
        const rut = normalizeRut(record.rut);
        if (seen.has(key) || (rut && ruts.has(rut))) {
            duplicates++;
            continue;
        }
        seen.add(key);
        if (rut) ruts.add(rut);
        if ([record.academic_email, record.financial_email].some((email) => email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
            questionableEmails++;
        }
        students.push({ ...record, rut: /^\d{1,8}[\dK]$/.test(rut) ? rut : '' });
    }
    const courses = new Set(saved.tutors.map((tutor) => tutor.course));
    const tutors = roster.tutors.filter((tutor) => {
        if (!tutor.name || !tutor.course || courses.has(tutor.course)) return false;
        courses.add(tutor.course);
        return true;
    });
    return { students, tutors, invalid, duplicates, questionableEmails };
}

importButton.addEventListener('click', () => {
    if (isAdmin() && !saving) importFile.click();
});

importFile.addEventListener('change', async () => {
    const file = importFile.files[0];
    if (!file || !isAdmin() || saving) return;
    importButton.disabled = true;
    showMessage('import-status', 'Leyendo el archivo…');
    showMessage('import-notes', '');
    try {
        const roster = await readRoster(file);
        if (!isAdmin() || importFile.files[0] !== file) return;
        const previous = session.data;
        const { students, tutors, invalid, duplicates, questionableEmails } = reviewRoster(roster, previous);
        if (students.length || tutors.length) {
            await persist({ ...previous,
                students: [...previous.students, ...students.map((row) => ({ ...row, id: crypto.randomUUID() }))],
                tutors: [...previous.tutors, ...tutors]
            });
            search.value = '';
            render();
            search.focus();
        }
        const added = [students.length && `${students.length} ${students.length === 1 ? 'ficha' : 'fichas'}`,
            tutors.length && `${tutors.length} ${tutors.length === 1 ? 'tutor' : 'tutores'}`].filter(Boolean);
        showMessage('import-status', added.length ? `Importación guardada. Nuevos registros: ${added.join(' y ')}.`
            : 'No se agregaron registros nuevos.');
        const notes = [duplicates && `${duplicates} ${duplicates === 1 ? 'coincidencia conservada' : 'coincidencias conservadas'}`,
            invalid && `${invalid} ${invalid === 1 ? 'fila omitida' : 'filas omitidas'} por nombre o curso incompleto`,
            questionableEmails && `${questionableEmails} ${questionableEmails === 1 ? 'ficha con correo' : 'fichas con correo'} para revisar`].filter(Boolean);
        showMessage('import-notes', notes.length ? notes.join(' · ') + '.' : '');
    } catch (error) {
        if (isAdmin() && importFile.files[0] === file) showMessage('import-status', error.message);
    } finally {
        if (importFile.files[0] === file) importFile.value = '';
        importButton.disabled = false;
    }
});

get('backup-export').addEventListener('click', async () => {
    if (!isAdmin() || saving) return;
    try {
        const payload = await exportEncryptedBackup(session);
        const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `student-finder-respaldo-${todayInChile()}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showMessage('backup-status', 'Respaldo cifrado descargado.');
    } catch (error) { showMessage('backup-status', error.message); }
});

get('backup-open').addEventListener('click', () => { if (isAdmin() && !saving) backupFile.click(); });
backupFile.addEventListener('change', async () => {
    const file = backupFile.files[0];
    if (!file || !isAdmin() || saving) return;
    saving = true;
    get('logout').disabled = true;
    try {
        session = await restoreEncryptedBackup(session, file);
        render();
        showMessage('backup-status', 'Respaldo incorporado.');
    } catch (error) { showMessage('backup-status', error.message); }
    finally {
        backupFile.value = '';
        saving = false;
        get('logout').disabled = false;
    }
});

function openFolio(record) {
    if (!isAdmin()) return;
    editingFolio = record?.code;
    folioForm.reset();
    if (record) {
        folioForm.elements.expiresOn.value = record.expiresOn || '';
        folioForm.elements.published.checked = record.published;
        folioForm.elements.annulled.checked = record.annulled;
    }
    get('folio-result').hidden = !record;
    get('folio-code').value = record?.code || '';
    showMessage('folio-status', '');
    folioDialog.showModal();
}

get('make-folio').addEventListener('click', () => { if (selectedStudent()) openFolio(); });
get('copy-folio').addEventListener('click', () => copy(get('folio-code').value, 'folio-status'));

handleSubmit(folioForm, 'folio-status', async () => {
    if (!isAdmin()) return;
    const old = session.data;
    const previous = old.folios.find((entry) => entry.code === editingFolio);
    const record = {
        studentId: previous?.studentId ?? selectedStudent()?.id,
        code: previous?.code ?? newCode(),
        expiresOn: folioForm.elements.expiresOn.value || null,
        published: folioForm.elements.published.checked,
        annulled: folioForm.elements.annulled.checked
    };
    if (!record.studentId) throw new Error('Primero abre la ficha de un estudiante.');
    const folios = previous ? old.folios.map((entry) => entry.code === previous.code ? record : entry) : [...old.folios, record];
    await persist({ ...old, folios });
    editingFolio = record.code;
    get('folio-result').hidden = false;
    get('folio-code').value = record.code;
    showMessage('folio-status', record.published ? 'Folio guardado. Puedes consultarlo con «Validar folio».' : 'Folio guardado como privado.');
    renderFolios();
});

get('open-validation').addEventListener('click', () => {
    if (!session) return;
    validationForm.reset();
    showMessage('validation-status', '');
    validationDialog.showModal();
});

handleSubmit(validationForm, 'validation-status', async () => {
    if (!session) return;
    const validatingSession = session;
    const value = validationForm.elements.code.value;
    const result = await validateCode(value);
    if (session === validatingSession && validationDialog.open && validationForm.elements.code.value === value) {
        showMessage('validation-status', statusText[result]);
    }
});

for (const button of document.querySelectorAll('dialog .close')) {
    button.addEventListener('click', () => button.closest('dialog').close());
}

configureLogin();
