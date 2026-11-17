import { createVault, folioStatus, newCode, readVault, saveVault, unlock, validateCode } from './local-data.js';
import { normalizeCourse, normalized, readRoster } from './student-import.js';

const get = (id) => document.getElementById(id);
const login = get('login');
const studentForm = get('student-form');
const importForm = get('import');
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
let needsSetup;
let saving = false;
let selected;
let editing;
let editingFolio;
let pendingImport;

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

async function configureLogin() {
    if (!globalThis.crypto?.subtle || !globalThis.indexedDB) {
        showMessage('login-status', 'Abre esta página en un navegador actualizado mediante HTTPS.');
        return;
    }
    try {
        needsSetup = !(await readVault());
        get('login-hint').textContent = needsSetup
            ? 'Primer acceso. Crea una contraseña de al menos 12 caracteres para este navegador.'
            : 'Usa la contraseña que creaste en este navegador.';
        get('repeat-password').hidden = !needsSetup;
        login.elements.confirmation.disabled = !needsSetup;
        login.elements.confirmation.required = needsSetup;
        login.elements.password.minLength = needsSetup ? 12 : 1;
        login.elements.password.autocomplete = needsSetup ? 'new-password' : 'current-password';
        get('enter').textContent = needsSetup ? 'Crear acceso e ingresar' : 'Entrar';
        get('enter').disabled = false;
    } catch (error) {
        showMessage('login-status', error.message);
    }
}

get('reveal').addEventListener('click', () => {
    const show = login.elements.password.type === 'password';
    login.elements.password.type = show ? 'text' : 'password';
    login.elements.confirmation.type = login.elements.password.type;
    get('reveal').setAttribute('aria-pressed', String(show));
    get('reveal').textContent = show ? 'Ocultar contraseña' : 'Mostrar contraseña';
});

handleSubmit(login, 'login-status', async () => {
    const password = login.elements.password.value;
    const envelope = await readVault();
    if (needsSetup && envelope) {
        await configureLogin();
        throw new Error('El acceso ya fue creado en otra pestaña. Ingresa con esa contraseña.');
    }
    if (envelope) {
        session = await unlock(password, envelope);
    } else {
        if (!needsSetup) {
            await configureLogin();
            throw new Error('Crea el acceso de administrador para este navegador.');
        }
        if (password !== login.elements.confirmation.value) throw new Error('Las contraseñas no coinciden.');
        session = await createVault(password);
    }
    login.reset();
    if (login.elements.password.type === 'text') get('reveal').click();
    get('entry').hidden = true;
    get('workspace').hidden = false;
    get('logout').hidden = false;
    render();
    importForm.elements.file.focus();
});

function resetImport() {
    pendingImport = null;
    get('import-review').hidden = true;
    showMessage('import-summary', '');
    showMessage('import-notes', '');
}

get('logout').addEventListener('click', () => {
    if (saving) return;
    session = null;
    selected = null;
    editing = null;
    editingFolio = null;
    resetImport();
    importForm.reset();
    studentForm.reset();
    folioForm.reset();
    login.reset();
    search.value = '';
    for (const id of ['results', 'contact-cards', 'folio-list']) get(id).replaceChildren();
    for (const id of ['student-name', 'student-course', 'student-count', 'search-status', 'workspace-status',
        'import-status', 'student-status', 'folio-status']) showMessage(id, '');
    get('folio-code').value = '';
    get('folio-result').hidden = true;
    for (const dialog of [studentDialog, folioDialog]) if (dialog.open) dialog.close();
    get('student-card').hidden = true;
    get('workspace').hidden = true;
    get('logout').hidden = true;
    get('entry').hidden = false;
    get('enter').disabled = true;
    configureLogin().then(() => login.elements.password.focus());
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

function asResult(record) {
    const item = document.createElement('li');
    item.append(text('strong', record.name), text('span', record.course),
        action('Ver ficha', () => {
            selected = record.id;
            renderStudent();
            get('student-card').scrollIntoView({ block: 'nearest' });
        }));
    return item;
}

function renderResults() {
    if (!session) return;
    const terms = normalized(search.value).split(/\s+/).filter(Boolean);
    const matches = session.data.students.filter((record) => {
        const haystack = normalized([record.name, record.course, record.academic_name, record.financial_name].join(' '));
        return terms.every((term) => haystack.includes(term));
    });
    matches.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    get('results').replaceChildren(...matches.slice(0, 30).map(asResult));
    showMessage('search-status', matches.length > 30 ? `Mostrando 30 de ${matches.length} fichas. Acota la búsqueda.`
        : matches.length ? `${matches.length} ${matches.length === 1 ? 'ficha' : 'fichas'}` : 'No se encontraron fichas.');
}

function selectedStudent() {
    return session?.data.students.find((record) => record.id === selected);
}

function contacts(record) {
    const tutor = session.data.tutors.find((item) => item.course === record.course);
    return [
        ['Profesor tutor', [tutor?.name, tutor?.email]],
        ['Apoderado académico', [record.academic_name, record.academic_phone, record.academic_email]],
        ['Apoderado de cuentas', [record.financial_name, record.financial_phone, record.financial_email]]
    ];
}

function renderStudent() {
    const record = selectedStudent();
    get('student-card').hidden = !record;
    showMessage('student-name', record?.name ?? '');
    showMessage('student-course', record?.course ?? '');
    const cards = record ? contacts(record).map(([label, entries]) => {
        const section = document.createElement('section');
        const lines = entries.filter(Boolean);
        section.append(text('h3', label), ...(lines.length ? lines : ['Sin registrar']).map((line) => text('p', line)));
        return section;
    }) : [];
    get('contact-cards').replaceChildren(...cards);
}

function renderFolios() {
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
    showMessage('student-count', `${session.data.students.length} estudiantes guardados en este navegador`);
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
    if (!record.name || !record.course) throw new Error('Completa el nombre y el curso.');
    record.id = editing ?? crypto.randomUUID();
    const old = session.data;
    const students = editing ? old.students.map((item) => item.id === editing ? record : item) : [...old.students, record];
    await persist({ ...old, students });
    selected = record.id;
    studentDialog.close();
    render();
    showMessage('workspace-status', 'Ficha guardada.');
});

get('remove-student').addEventListener('click', async () => {
    const record = selectedStudent();
    if (!record || !confirm('¿Eliminar esta ficha y sus folios en este navegador?')) return;
    try {
        const old = session.data;
        await persist({ ...old,
            students: old.students.filter((item) => item.id !== record.id),
            folios: old.folios.filter((folio) => folio.studentId !== record.id)
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
    if (record) copy([record.name, record.course, ...contacts(record).flatMap(([label, values]) =>
        [label, ...values.filter(Boolean)])].join('\n'), 'workspace-status');
});

function studentKey(record) {
    return normalized(record.name) + '\u0000' + normalized(record.course);
}

export function reviewRoster(roster, saved) {
    const seen = new Set(saved.students.map(studentKey));
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
        if (seen.has(key)) {
            duplicates++;
            continue;
        }
        seen.add(key);
        if ([record.academic_email, record.financial_email].some((email) => email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
            questionableEmails++;
        }
        students.push(record);
    }
    const courses = new Set(saved.tutors.map((tutor) => tutor.course));
    const tutors = roster.tutors.filter((tutor) => {
        if (!tutor.name || !tutor.course || courses.has(tutor.course)) return false;
        courses.add(tutor.course);
        return true;
    });
    return { students, tutors, invalid, duplicates, questionableEmails };
}

importForm.elements.file.addEventListener('change', () => {
    resetImport();
    showMessage('import-status', '');
});
get('import-cancel').addEventListener('click', resetImport);

handleSubmit(importForm, 'import-status', async () => {
    resetImport();
    const file = importForm.elements.file.files[0];
    if (!file) throw new Error('Selecciona un archivo.');
    if (!file.name.toLowerCase().endsWith('.json') && !globalThis.XLSX) {
        throw new Error('No se cargó el lector de Excel. Vuelve a cargar la página.');
    }
    const roster = await readRoster(file);
    if (!session || importForm.elements.file.files[0] !== file) return;
    pendingImport = reviewRoster(roster, session.data);
    const { students, tutors, invalid, duplicates, questionableEmails } = pendingImport;
    get('import-review').hidden = false;
    showMessage('import-summary', `${students.length} fichas nuevas · ${tutors.length} tutores nuevos`);
    showMessage('import-notes', `${duplicates} coincidencias conservadas · ${invalid} filas omitidas por nombre o curso incompleto · ${questionableEmails} fichas con correos para revisar.`);
    get('import-commit').disabled = !students.length && !tutors.length;
});

get('import-commit').addEventListener('click', async () => {
    if (!pendingImport || saving) return;
    const previous = session.data;
    const batch = reviewRoster(pendingImport, previous);
    try {
        await persist({ ...previous,
            students: [...previous.students, ...batch.students.map((row) => ({ ...row, id: crypto.randomUUID() }))],
            tutors: [...previous.tutors, ...batch.tutors]
        });
        resetImport();
        importForm.reset();
        render();
        showMessage('import-status', `Importación guardada. Se agregaron ${batch.students.length} fichas.`);
    } catch (error) { showMessage('import-status', error.message); }
});

function openFolio(record) {
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
    validationForm.reset();
    showMessage('validation-status', '');
    validationDialog.showModal();
});

handleSubmit(validationForm, 'validation-status', async () => {
    const value = validationForm.elements.code.value;
    const result = await validateCode(value);
    if (validationDialog.open && validationForm.elements.code.value === value) {
        showMessage('validation-status', statusText[result]);
    }
});

for (const button of document.querySelectorAll('dialog .close')) {
    button.addEventListener('click', () => button.closest('dialog').close());
}

configureLogin();
