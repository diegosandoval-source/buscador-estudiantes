import { changeInitialPassword, checkSession, folioStatus, listUsers, manageUser, newCode, openAccount, refreshSession,
    saveVault, todayInChile, validateCode } from './local-data.js?v=15';
import { normalizeCourse, normalized, readRoster } from './student-import.js?v=15';
import { displayRut, normalizeRut, resolveStudent, studentMatches, validationFromForm, validationLabels } from './validation-records.js?v=15';
import { comparisonLabels, courseSummaries, importFields, inspectWorkbook, mergeImportedStudents,
    parseMappedSheet, suggestMapping, withComparisons } from './school-records.js?v=15';

const get = (id) => document.getElementById(id);
const login = get('login');
const passwordForm = get('password-change');
const passwordDialog = get('password-dialog');
const recordForm = get('record-form');
const recordDialog = get('record-dialog');
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
let pendingPasswordChange;
let changingPassword = false;
let saving = false;
let selected;
let editing;
let editingFolio;
let recordStudentId;
let recordValidationId;
let pendingWorkbook;
let importPurpose = 'students';
let editingUser;
let editingCourse;
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
    get('load-data').hidden = !admin;
    get('connected-user').hidden = false;
    for (const id of ['make-folio', 'remove-student', 'open-import', 'new-student', 'edit-student',
        'add-validation', 'review-comparison', 'admin-tools']) get(id).hidden = !admin;
    showMessage('role-label', admin ? 'Administración' : 'Consulta');
    showMessage('welcome-title', 'Bienvenido, ' + (nextSession.username === 'admin' ? 'Administrador'
        : nextSession.username === 'enfermeria' ? 'Enfermería' : nextSession.username));
    showMessage('open-results', admin ? 'Validar estudiantes' : 'Resultados por curso');
    showMessage('connected-user', nextSession.username);
    showMessage('search-label', admin ? 'Nombre, apellido, RUT, curso o folio' : 'Nombre, apellido, curso o folio');
    try {
        if (login.elements.remember.checked) localStorage.setItem(rememberedUserKey, nextSession.username);
        else localStorage.removeItem(rememberedUserKey);
    } catch { /* El acceso funciona sin preferencias guardadas. */ }
    render();
    search.focus({ preventScroll: true });
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
    const account = credentials();
    clearLoginPassword();
    completeLogin(await openAccount(...account));
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

get('logout').addEventListener('click', () => {
    if (saving) return;
    session = null;
    selected = null;
    editing = null;
    editingFolio = null;
    editingUser = null;
    editingCourse = null;
    pendingWorkbook = null;
    recordStudentId = null;
    recordValidationId = null;
    importFile.value = '';
    studentForm.reset();
    folioForm.reset();
    recordForm.reset();
    validationForm.reset();
    login.reset();
    search.value = '';
    get('search-results').hidden = true;
    for (const id of ['results', 'contact-cards', 'student-history', 'comparison-fields', 'comparison-reasons',
        'user-list', 'tutor-list', 'course-summaries', 'course-students', 'audit-list', 'mapping-columns', 'mapping-contacts']) get(id).replaceChildren();
    for (const id of ['student-name', 'student-course', 'student-rut', 'connected-user', 'search-status', 'workspace-status',
        'import-status', 'import-notes', 'student-status', 'folio-status', 'validation-status']) showMessage(id, '');
    get('folio-code').value = '';
    get('folio-result').hidden = true;
    for (const dialog of document.querySelectorAll('dialog')) if (dialog.open) dialog.close();
    for (const form of document.querySelectorAll('dialog form')) form.reset();
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

async function persist(data, operation = 'datos.actualizar', subject = '', details = {}) {
    if (!session || saving) throw new Error('Espera a que termine la operación anterior.');
    saving = true;
    get('logout').disabled = true;
    try {
        const compared = withComparisons(data, { ...session.data, comparisons: data.comparisons ?? [] });
        const audit = [...(compared.audit ?? []), {
            id: crypto.randomUUID(), at: new Date().toISOString(), actor: session.username, action: operation, subject, details
        }];
        session = await saveVault(session, { ...compared, audit });
    }
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
    const profile = document.createElement('div');
    profile.className = 'result-profile';
    const initials = record.name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0]).join('');
    const avatar = text('span', initials.toLocaleUpperCase('es'));
    avatar.className = 'result-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    const description = document.createElement('div');
    description.className = 'result-line';
    const states = [...new Set(history.map((entry) => folioStatus(entry)))];
    const detail = [record.course, isAdmin() && record.rut ? 'RUT ' + displayRut(record.rut) : '',
        `${history.length} ${history.length === 1 ? 'validación' : 'validaciones'}`].filter(Boolean).join(' · ');
    description.append(text('strong', record.name), text('span', detail));
    if (states.length) {
        const labels = document.createElement('div');
        labels.className = 'state-labels';
        labels.append(...states.map((state) => {
            const badge = text('span', validationLabels[state]);
            badge.className = 'state-label';
            badge.dataset.state = state;
            return badge;
        }));
        description.append(labels);
    }
    profile.append(avatar, description);
    const comparison = session.data.comparisons.find((entry) => entry.studentId === record.id);
    if (comparison) description.append(comparisonBadge(comparison.status));
    const openButton = action('Ver detalle', () => openStudentDetail(record.id));
    openButton.className += ' result-open';
    item.append(profile, openButton);
    return item;
}

function renderResults() {
    if (!session) return;
    const query = search.value.trim();
    const hasStudents = session.data.students.length > 0;
    const emptyMessage = isAdmin()
        ? 'Actualmente no existen alumnos registrados. Para comenzar, presiona el botón Agregar validación.'
        : 'Actualmente no existen alumnos registrados. Solicita la carga de datos a Administración.';
    get('search-results').hidden = !query && hasStudents;
    if (!query) {
        get('results').replaceChildren();
        get('search-keyboard').hidden = true;
        showMessage('search-status', hasStudents ? '' : '0 resultados encontrados');
        get('empty-results').hidden = hasStudents;
        showMessage('empty-results-message', emptyMessage);
        return;
    }
    const byStudent = histories();
    const matches = session.data.students.filter((record) => studentMatches(record, byStudent.get(record.id) ?? [], query));
    matches.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    get('results').replaceChildren(...matches.slice(0, 30).map((record) => asResult(record, byStudent.get(record.id) ?? [])));
    get('search-keyboard').hidden = matches.length === 0;
    get('empty-results').hidden = matches.length > 0;
    showMessage('empty-results-message', session.data.students.length
        ? 'No hay alumnos que coincidan con tu búsqueda.'
        : emptyMessage);
    const count = `${matches.length} ${matches.length === 1 ? 'resultado encontrado' : 'resultados encontrados'}`;
    showMessage('search-status', matches.length > 30 ? `${count}. Se muestran 30.` : count);
}

function selectedStudent() {
    return session?.data.students.find((record) => record.id === selected);
}

function openStudentDetail(id) {
    selected = id;
    renderStudent();
    get('student-name').focus({ preventScroll: true });
    get('student-card').scrollIntoView({ block: 'nearest' });
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
    renderComparison();
}

function render() {
    renderResults();
    renderStudent();
}

search.addEventListener('input', renderResults);

function navigateResults(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
    if (event.key === 'Escape' && event.currentTarget === get('results')) {
        event.preventDefault();
        search.focus();
        return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = Array.from(get('results').querySelectorAll('.result-open'));
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowUp' && current === 0) {
        search.focus();
        return;
    }
    const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
        : current + (event.key === 'ArrowDown' ? 1 : -1);
    buttons[Math.min(next, buttons.length - 1)].focus();
}

search.addEventListener('keydown', navigateResults);
get('results').addEventListener('keydown', navigateResults);

function syncContacts() {
    const same = get('same-contact').checked;
    for (const field of fields) {
        const financial = studentForm.elements['financial_' + field];
        financial.readOnly = same;
        if (same) financial.value = studentForm.elements['academic_' + field].value;
    }
}

function openStudent(record) {
    if (!isAdmin()) return;
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
    if (!isAdmin()) throw new Error('Esta operación requiere Administración.');
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
    record.comparisonRut = record.rut;
    const old = session.data;
    const students = editing ? old.students.map((item) => item.id === editing ? { ...item, ...record } : item) : [...old.students, record];
    await persist({ ...old, students }, editing ? 'estudiante.editar' : 'estudiante.crear', record.id, {
        before: old.students.find((item) => item.id === editing) ?? null, after: record
    });
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
        }, 'estudiante.eliminar', record.id, { before: record });
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
    const comparison = session?.data.comparisons.find((entry) => entry.studentId === record?.id);
    const lines = comparison ? [
        'Resultado: ' + comparisonLabels[comparison.status], 'Última comparación: ' + formatDate(comparison.comparedAt),
        ...comparison.fields.map((field) => field.label + ' · Referencia: ' + (field.reference || 'Sin dato')
            + ' · Validación: ' + (field.submitted || 'Sin dato')),
        ...comparison.reasons, comparison.review ? 'Revisión: ' + comparison.review.note : ''
    ] : [];
    if (record) copy([record.name, record.course, isAdmin() ? displayRut(record.rut) : '', ...contacts(record).flatMap(([label, values]) =>
        [label, ...values.filter(Boolean)]), ...lines].filter(Boolean).join('\n'), 'workspace-status');
});

function openRecord(student = null, record = null) {
    if (!isAdmin()) return;
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
    showMessage('record-title', record ? 'Editar validación' : 'Agregar validación');
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
    if (!isAdmin()) throw new Error('Esta operación requiere Administración.');
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
    else if (fields.rut) {
        students = students.map((item) => item.id === student.id ? {
            ...item, rut: item.rut || normalizeRut(fields.rut), comparisonRut: normalizeRut(fields.rut)
        } : item);
    }
    const validations = previous ? before.validations.map((item) => item.id === previous.id ? entry : item)
        : [...before.validations, entry];
    await persist({ ...before, students, validations }, previous ? 'validacion.editar' : 'validacion.crear', student.id);
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
        await persist({ ...old, validations: old.validations.filter(({ id }) => id !== record.id) }, 'validacion.eliminar', record.id);
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
    if (isAdmin() && !saving) { importPurpose = 'students'; importFile.click(); }
});

get('open-reference').addEventListener('click', () => {
    if (isAdmin() && !saving) { importPurpose = 'reference'; importFile.click(); }
});

importFile.addEventListener('change', async () => {
    const file = importFile.files[0];
    if (!file || !isAdmin() || saving) return;
    importButton.disabled = true;
    showMessage('import-status', 'Leyendo el archivo…');
    showMessage('import-notes', '');
    try {
        await checkSession(session, true);
        if (!file.name.toLowerCase().endsWith('.json')) {
            pendingWorkbook = await inspectWorkbook(file);
            if (!isAdmin() || importFile.files[0] !== file) return;
            const form = get('mapping-form');
            form.reset();
            setOptions(form.elements.sheet, pendingWorkbook.sheets.map((sheet, index) => [String(index), sheet.name]), '0');
            form.elements.purpose.value = importPurpose;
            form.elements.header.value = pendingWorkbook.sheets[0].header + 1;
            showMessage('mapping-filename', file.name);
            showMessage('mapping-status', '');
            renderMapping();
            get('mapping-dialog').showModal();
            showMessage('import-status', '');
            return;
        }
        const roster = await readRoster(file);
        if (!isAdmin() || importFile.files[0] !== file) return;
        const previous = session.data;
        const merged = mergeImportedStudents(previous.students, roster.students);
        const tutors = new Map(previous.tutors.map((tutor) => [normalizeCourse(tutor.course), tutor]));
        for (const tutor of roster.tutors) tutors.set(normalizeCourse(tutor.course), tutor);
        await persist({ ...previous, students: merged.students, tutors: Array.from(tutors.values()) }, 'base.importar', file.name);
        search.value = '';
        render();
        showMessage('import-status', `Importación guardada. ${merged.added} alumnos agregados y ${merged.updated} actualizados.`);
    } catch (error) {
        if (isAdmin() && importFile.files[0] === file) showMessage('import-status', error.message);
    } finally {
        if (importFile.files[0] === file) importFile.value = '';
        importButton.disabled = false;
    }
});

function setOptions(select, entries, selectedValue = '') {
    select.replaceChildren(...entries.map(([value, label]) => {
        const option = text('option', label);
        option.value = value;
        return option;
    }));
    select.value = selectedValue;
}

function currentImport() {
    const form = get('mapping-form');
    const sheet = pendingWorkbook?.sheets[Number(form.elements.sheet.value)];
    if (!sheet) throw new Error('Vuelve a seleccionar el archivo.');
    const header = Number(form.elements.header.value) - 1;
    const mapping = Object.fromEntries(importFields.map((field) => [field.key, Number(form.elements[field.key].value)]));
    return parseMappedSheet(sheet, header, mapping);
}

function renderMapping() {
    if (!pendingWorkbook) return;
    const form = get('mapping-form');
    const sheet = pendingWorkbook.sheets[Number(form.elements.sheet.value)];
    const header = Number(form.elements.header.value) - 1;
    form.elements.header.max = sheet.rows.length;
    const headers = sheet.rows[header] ?? [];
    const mapping = suggestMapping(headers);
    const columns = Math.max(headers.length, ...sheet.rows.slice(header + 1, header + 5).map((row) => row.length));
    get('mapping-columns').replaceChildren();
    get('mapping-contacts').replaceChildren();
    for (const field of importFields) {
        const label = text('label', field.label);
        const select = document.createElement('select');
        select.name = field.key;
        setOptions(select, [['-1', 'Sin columna'], ...Array.from({ length: columns }, (_, index) => [
            String(index), XLSX.utils.encode_col(index) + ' · ' + (headers[index] || 'Sin encabezado')
        ])], String(mapping[field.key]));
        select.addEventListener('change', previewMapping);
        label.append(select);
        get(field.contacts ? 'mapping-contacts' : 'mapping-columns').append(label);
    }
    previewMapping();
}

function previewMapping() {
    try {
        const roster = currentImport();
        showMessage('mapping-preview', `${roster.students.length} alumnos · ${roster.tutors.length} cursos con tutor · ${roster.omitted} filas omitidas.`);
        showMessage('mapping-hint', roster.students.length
            ? get('mapping-form').elements.purpose.value === 'reference'
                ? 'Al confirmar, esta nómina se utilizará como referencia para las comparaciones.'
                : 'Al confirmar, se actualizarán las fichas coincidentes y se compararán con la nómina de referencia.'
            : 'Esta hoja aporta cursos y tutores. Para acreditar la identidad de los alumnos, carga también una nómina de referencia.');
    } catch (error) {
        showMessage('mapping-preview', error.message);
        showMessage('mapping-hint', '');
    }
}

get('mapping-form').elements.sheet.addEventListener('change', () => {
    const form = get('mapping-form');
    form.elements.header.value = pendingWorkbook.sheets[Number(form.elements.sheet.value)].header + 1;
    renderMapping();
});
get('mapping-form').elements.header.addEventListener('input', renderMapping);
get('mapping-form').elements.purpose.addEventListener('change', previewMapping);
get('mapping-dialog').addEventListener('close', () => { pendingWorkbook = null; });

handleSubmit(get('mapping-form'), 'mapping-status', async () => {
    if (!isAdmin()) throw new Error('Esta operación requiere Administración.');
    const roster = currentImport();
    const filename = pendingWorkbook.name;
    const previous = session.data;
    const reference = get('mapping-form').elements.purpose.value === 'reference';
    if (!reference && !roster.students.length) throw new Error('Selecciona «Cursos, tutores o nómina de referencia» para importar esta hoja.');
    let data;
    let summary;
    if (reference) {
        const tutors = new Map(previous.tutors.map((tutor) => [normalizeCourse(tutor.course), tutor]));
        for (const tutor of roster.tutors) tutors.set(normalizeCourse(tutor.course), tutor);
        data = { ...previous, tutors: Array.from(tutors.values()),
            referenceStudents: roster.students.length ? roster.students.map((row) => ({ ...row, id: crypto.randomUUID() })) : previous.referenceStudents,
            referenceMeta: {
                filename: roster.students.length ? filename : previous.referenceMeta?.filename ?? filename,
                tutorFilename: roster.tutors.length ? filename : previous.referenceMeta?.tutorFilename ?? '',
                at: new Date().toISOString(), count: roster.students.length || previous.referenceStudents.length
            }
        };
        summary = `Referencia guardada. ${roster.tutors.length} cursos con tutor y ${data.referenceStudents.length} alumnos de referencia.`;
    } else {
        const merged = mergeImportedStudents(previous.students, roster.students);
        data = { ...previous, students: merged.students };
        summary = `Datos guardados. ${merged.added} alumnos agregados, ${merged.updated} actualizados y ${merged.conflicts} conflictos para revisar.`;
    }
    await persist(data, reference ? 'referencia.importar' : 'base.importar', filename, {
        students: roster.students.length, tutors: roster.tutors.length, omitted: roster.omitted
    });
    get('mapping-dialog').close();
    search.value = '';
    render();
    showMessage('import-status', summary);
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
    await persist({ ...old, folios }, 'folio.guardar', record.code);
    editingFolio = record.code;
    get('folio-result').hidden = false;
    get('folio-code').value = record.code;
    showMessage('folio-status', record.published ? 'Folio guardado. Puedes consultarlo con «Validar folio».' : 'Folio guardado como privado.');
    render();
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

function formatDate(value) {
    if (!value || Number.isNaN(new Date(value).getTime())) return 'Sin fecha';
    return new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Santiago' }).format(new Date(value));
}

function comparisonBadge(status) {
    const badge = text('span', comparisonLabels[status] ?? comparisonLabels.pendiente);
    badge.className = 'comparison-state';
    badge.dataset.state = status;
    return badge;
}

function tableRow(values) {
    const row = document.createElement('tr');
    row.append(...values.map((value) => {
        const cell = document.createElement('td');
        if (value && typeof value === 'object') cell.append(value);
        else cell.textContent = String(value ?? '');
        return cell;
    }));
    return row;
}

function renderComparison() {
    const student = selectedStudent();
    const entry = session?.data.comparisons.find((comparison) => comparison.studentId === student?.id);
    const status = entry?.status ?? 'pendiente';
    showMessage('comparison-state', comparisonLabels[status]);
    get('comparison-state').dataset.state = status;
    showMessage('comparison-date', entry ? 'Última comparación · ' + formatDate(entry.comparedAt) : 'Todavía no se ha ejecutado una comparación.');
    get('comparison-fields').replaceChildren(...(entry?.fields ?? []).map((field) => {
        const row = tableRow([field.label, field.reference || 'Sin dato', field.submitted || 'Sin dato']);
        if (field.different) row.className = 'difference';
        return row;
    }));
    get('comparison-reasons').replaceChildren(...(entry?.reasons ?? []).map((reason) => text('li', reason)));
    showMessage('comparison-review', entry?.review
        ? 'Revisión de ' + entry.review.actor + ' · ' + formatDate(entry.review.at) + ' · ' + entry.review.note : '');
    get('review-comparison').hidden = !isAdmin() || !entry;
}

get('review-comparison').addEventListener('click', () => {
    if (!isAdmin()) return;
    const entry = session.data.comparisons.find((comparison) => comparison.studentId === selected);
    if (!entry) return;
    get('review-form').reset();
    get('review-form').elements.status.value = entry.status;
    showMessage('review-status', '');
    get('review-dialog').showModal();
});

handleSubmit(get('review-form'), 'review-status', async () => {
    if (!isAdmin()) throw new Error('Esta operación requiere Administración.');
    const form = get('review-form');
    const status = form.elements.status.value;
    const note = form.elements.note.value.trim();
    if (!comparisonLabels[status] || !note) throw new Error('Selecciona el resultado y explica la revisión realizada.');
    const before = session.data.comparisons.find((entry) => entry.studentId === selected);
    if (!before) throw new Error('Vuelve a abrir la ficha del estudiante.');
    const review = { actor: session.username, at: new Date().toISOString(), note };
    const comparisons = session.data.comparisons.map((entry) => entry.id === before.id ? { ...entry, status, review } : entry);
    await persist({ ...session.data, comparisons, comparisonHistory: [...session.data.comparisonHistory, before] },
        'comparacion.revisar', selected, { before: before.status, after: status, note });
    get('review-dialog').close();
    render();
    showMessage('workspace-status', 'Revisión guardada en el historial.');
});

function resetUserForm() {
    editingUser = null;
    get('user-form').reset();
    get('user-form').elements.active.checked = true;
    showMessage('user-form-title', 'Crear usuario');
    showMessage('user-status', '');
}

async function renderUsers() {
    const users = await listUsers(session);
    get('user-list').replaceChildren(...users.map((user) => {
        const access = document.createElement('div');
        access.className = 'stack';
        if (user.temporaryPassword) {
            access.append(text('code', user.temporaryPassword), action('Copiar clave temporal', () => copy(user.temporaryPassword, 'user-status')));
        } else access.append(text('span', user.needsPassword ? 'Pendiente' : 'Contraseña personal'));
        const actions = document.createElement('div');
        actions.className = 'actions';
        actions.append(action('Editar', () => {
            editingUser = user.id;
            const form = get('user-form');
            form.elements.username.value = user.username;
            form.elements.role.value = user.role;
            form.elements.active.checked = user.active;
            showMessage('user-form-title', 'Editar usuario');
            showMessage('user-status', '');
            form.elements.username.focus();
        }), action('Restablecer clave', async () => {
            if (!confirm('¿Generar una contraseña temporal nueva para ' + user.username + '?')) return;
            await saveUser({ id: user.id, username: user.username, role: user.role, active: user.active, reset: true });
        }));
        return tableRow([user.username, user.role === 'admin' ? 'Administrador' : 'Consulta',
            user.active ? 'Activa' : 'Desactivada', access, actions]);
    }));
}

async function saveUser(changes) {
    if (!isAdmin() || saving) return;
    saving = true;
    get('logout').disabled = true;
    try {
        const result = await manageUser(session, changes);
        session = result.session;
        await renderUsers();
        showMessage('user-status', result.password ? 'Usuario guardado. Copia su contraseña temporal desde la tabla.'
            : 'Usuario y permisos actualizados.');
    } catch (error) { showMessage('user-status', error.message); }
    finally { saving = false; get('logout').disabled = false; }
}

get('open-users').addEventListener('click', async () => {
    if (!isAdmin()) return;
    resetUserForm();
    try { await renderUsers(); get('users-dialog').showModal(); }
    catch (error) { showMessage('workspace-status', error.message); }
});
get('new-user').addEventListener('click', resetUserForm);
handleSubmit(get('user-form'), 'user-status', async () => {
    const form = get('user-form');
    await saveUser({ id: editingUser, username: form.elements.username.value, role: form.elements.role.value, active: form.elements.active.checked });
});

function renderTutors() {
    get('tutor-list').replaceChildren(...session.data.tutors.slice().sort((a, b) => a.course.localeCompare(b.course, 'es', { numeric: true })).map((tutor) =>
        tableRow([tutor.course, tutor.name, tutor.email, action('Editar', () => {
            editingCourse = tutor.course;
            const form = get('tutor-form');
            for (const key of ['course', 'name', 'email']) form.elements[key].value = tutor[key] ?? '';
            showMessage('tutor-status', '');
            form.elements.name.focus();
        })])));
}

get('open-courses').addEventListener('click', () => {
    if (!isAdmin()) return;
    editingCourse = null;
    get('tutor-form').reset();
    showMessage('tutor-status', '');
    renderTutors();
    get('courses-dialog').showModal();
});
get('new-course').addEventListener('click', () => {
    editingCourse = null;
    get('tutor-form').reset();
    showMessage('tutor-status', '');
});
handleSubmit(get('tutor-form'), 'tutor-status', async () => {
    if (!isAdmin()) throw new Error('Esta operación requiere Administración.');
    const form = get('tutor-form');
    const tutor = { course: normalizeCourse(form.elements.course.value), name: form.elements.name.value.trim(), email: form.elements.email.value.trim() };
    if (!tutor.course || !tutor.name) throw new Error('Completa el curso y el profesor tutor.');
    if (session.data.tutors.some((item) => item.course === tutor.course && item.course !== editingCourse)) {
        throw new Error('Ese curso ya tiene una ficha. Selecciona Editar en su fila.');
    }
    const previous = editingCourse;
    const tutors = [...session.data.tutors.filter((item) => item.course !== previous), tutor];
    const rename = (records) => previous && previous !== tutor.course
        ? records.map((record) => normalizeCourse(record.course) === previous ? { ...record, course: tutor.course } : record) : records;
    await persist({ ...session.data, tutors, students: rename(session.data.students),
        referenceStudents: rename(session.data.referenceStudents) }, 'tutor.guardar', tutor.course, {
        before: session.data.tutors.find((item) => item.course === previous) ?? null, after: tutor
    });
    editingCourse = tutor.course;
    renderTutors();
    render();
    showMessage('tutor-status', 'Curso y profesor tutor guardados.');
});

function renderCourseStudents() {
    const course = get('report-course').value;
    const state = get('report-state').value;
    const query = get('report-query').value;
    const comparisons = new Map(session.data.comparisons.map((entry) => [entry.studentId, entry]));
    const students = session.data.students.filter((student) =>
        (!course || normalizeCourse(student.course) === course)
        && (!state || (comparisons.get(student.id)?.status ?? 'pendiente') === state)
        && studentMatches(student, [], query));
    students.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    get('course-students').replaceChildren(...students.map((student) => {
        const item = document.createElement('li');
        const detail = document.createElement('div');
        detail.className = 'stack';
        detail.append(text('strong', student.name), text('span', student.course), comparisonBadge(comparisons.get(student.id)?.status ?? 'pendiente'));
        item.append(detail, action('Ver detalle', () => {
            get('reports-dialog').close();
            openStudentDetail(student.id);
        }));
        return item;
    }));
    showMessage('report-count', `${students.length} ${students.length === 1 ? 'alumno' : 'alumnos'} encontrados.`);
}

function renderReports() {
    const summaries = courseSummaries(session.data);
    showMessage('reference-summary', session.data.referenceStudents.length
        ? `${session.data.referenceStudents.length} alumnos de referencia · ${session.data.tutors.length} cursos con tutor.`
        : (session.data.referenceMeta?.count ?? 0) > 0
            ? `${session.data.referenceMeta.count} alumnos de referencia · ${session.data.tutors.length} cursos con tutor.`
            : 'Falta una nómina de referencia de alumnos. Las coincidencias de curso y tutor requieren revisión de identidad.');
    setOptions(get('report-course'), [['', 'Todos los cursos'], ...summaries.map((item) => [item.course, item.course])]);
    get('report-state').value = '';
    get('report-query').value = '';
    get('course-summaries').replaceChildren(...summaries.map((item) => tableRow([
        action(item.course, () => { get('report-course').value = item.course; renderCourseStudents(); }),
        item.tutor || 'Sin tutor asignado', item.total, item.validado, item.diferencias, item.no_encontrado, item.pendiente
    ])));
    renderCourseStudents();
}

get('report-course').addEventListener('change', renderCourseStudents);
get('report-state').addEventListener('change', renderCourseStudents);
get('report-query').addEventListener('input', renderCourseStudents);
get('open-results').addEventListener('click', async () => {
    const button = get('open-results');
    if (!session || saving) return;
    button.disabled = true;
    try {
        await checkSession(session);
        if (isAdmin()) {
            await persist(withComparisons(session.data, session.data, new Date().toISOString(), true), 'comparacion.ejecutar');
            render();
        }
        renderReports();
        get('reports-dialog').showModal();
    } catch (error) { showMessage('workspace-status', error.message); }
    finally { button.disabled = false; }
});

get('open-audit').addEventListener('click', () => {
    if (!isAdmin()) return;
    const labels = {
        'estudiante.crear': 'Creó una ficha', 'estudiante.editar': 'Editó una ficha', 'estudiante.eliminar': 'Eliminó una ficha',
        'validacion.crear': 'Agregó una validación', 'validacion.editar': 'Editó una validación', 'validacion.eliminar': 'Eliminó una validación',
        'referencia.importar': 'Importó una referencia', 'base.importar': 'Importó datos de alumnos',
        'comparacion.ejecutar': 'Ejecutó comparaciones', 'comparacion.revisar': 'Revisó un resultado',
        'tutor.guardar': 'Actualizó un curso o tutor', 'cuenta.crear': 'Creó un usuario', 'cuenta.actualizar': 'Actualizó un usuario',
        'cuenta.restablecer': 'Restableció una contraseña', 'folio.guardar': 'Guardó un folio'
    };
    get('audit-list').replaceChildren(...session.data.audit.slice().reverse().map((entry) => {
        const item = document.createElement('li');
        const body = document.createElement('div');
        body.className = 'stack';
        const details = entry.details ?? {};
        const subject = session.data.students.find((student) => student.id === entry.subject)?.name
            || details.before?.name || entry.subject || 'Registro general';
        body.append(text('strong', labels[entry.action] ?? 'Actualizó datos'),
            text('p', entry.actor + ' · ' + formatDate(entry.at)), text('p', subject));
        if (details.note) body.append(text('p', details.note));
        if (details.after && typeof details.after === 'object') {
            const fieldLabels = { name: 'Nombre', course: 'Curso', rut: 'RUT', email: 'Correo',
                academic_name: 'Apoderado académico', academic_phone: 'Teléfono académico', academic_email: 'Correo académico',
                financial_name: 'Apoderado de cuentas', financial_phone: 'Teléfono de cuentas', financial_email: 'Correo de cuentas' };
            for (const [key, label] of Object.entries(fieldLabels)) {
                if (Object.hasOwn(details.after, key) && details.before?.[key] !== details.after[key]) {
                    body.append(text('p', label + ' · ' + (details.before?.[key] || 'Sin dato') + ' → ' + (details.after[key] || 'Sin dato')));
                }
            }
        }
        if (details.students !== undefined) body.append(text('p', details.students + ' alumnos · ' + details.tutors + ' tutores · ' + details.omitted + ' filas omitidas'));
        if (details.role) body.append(text('p', (details.role === 'admin' ? 'Administrador' : 'Consulta') + ' · ' + (details.active ? 'Cuenta activa' : 'Cuenta desactivada')));
        item.append(body);
        return item;
    }));
    get('audit-dialog').showModal();
});

async function syncAccess() {
    if (!session || saving) return;
    const checked = session;
    try {
        await checkSession(checked);
        if (document.querySelector('dialog[open]')) return;
        const next = await refreshSession(checked);
        if (session === checked && next !== checked) { session = next; render(); }
    } catch (error) {
        if (session !== checked) return;
        get('logout').click();
        showMessage('login-status', error.message);
    }
}
setInterval(syncAccess, 15000);

for (const button of document.querySelectorAll('dialog .close')) {
    button.addEventListener('click', () => button.closest('dialog').close());
}

configureLogin();
