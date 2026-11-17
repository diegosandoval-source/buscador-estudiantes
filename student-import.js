const studentFields = {
    name: 'studentFullName', course: 'course',
    academic_name: 'academicName', academic_phone: 'academicPhone', academic_email: 'academicEmail',
    financial_name: 'financialName', financial_phone: 'financialPhone', financial_email: 'financialEmail'
};
const studentNameColumns = ['NOMBRE', 'NOMBRE_COMPLETO', 'ALUMNO', 'ESTUDIANTE', 'NOMBRE_ALUMNO', 'NOMBRE_DEL_ALUMNO'];

function clean(value) {
    const text = String(value ?? '').trim().replace(/\s+/g, ' ');
    return text === 'Sin registrar' ? '' : text;
}

export function normalized(value) {
    return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

export function normalizeCourse(value) {
    let compact = normalized(value).replace(/[^A-Z0-9]/g, '');
    const romans = { I: '1', II: '2', III: '3', IV: '4' };
    compact = compact.replace(/^(IV|III|II|I)(?=EM|MEDIO|MEDIA)/, (match) => romans[match]);
    const course = compact.match(/^([1-8])(?:ER|ERO|DO|RA|TO|VO|NO)?(BASICO|BASICA|MEDIO|MEDIA|EM)?([A-Z])$/);
    if (!course) return clean(value);
    const medium = ['MEDIO', 'MEDIA', 'EM'].includes(course[2]);
    if (medium && Number(course[1]) > 4) return clean(value);
    return `${course[1]}${medium ? 'EM' : ''}-${course[3]}`;
}

function rosterFromBackup(text) {
    const backup = JSON.parse(text);
    if (backup?.version !== 1 || !Array.isArray(backup.students) || !Array.isArray(backup.tutors)) {
        throw new Error('El archivo no tiene el formato de respaldo del buscador local.');
    }
    return {
        students: backup.students.map((record) => ({
            ...Object.fromEntries(Object.entries(studentFields).map(([field, oldField]) => [field, clean(record[oldField])])),
            course: normalizeCourse(record.course) || 'Sin curso'
        })),
        tutors: backup.tutors.map((record) => ({
            course: normalizeCourse(record.course), name: clean(record.teacherName), email: clean(record.teacherEmail)
        }))
    };
}

function rosterFromExcel(buffer) {
    if (!globalThis.XLSX) throw new Error('No se cargó el lector de Excel. Recarga la página.');
    const workbook = XLSX.read(buffer, { type: 'array', sheetRows: 10021 });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!worksheet) throw new Error('El Excel no contiene hojas.');
    if (worksheet['!fullref'] && XLSX.utils.decode_range(worksheet['!fullref']).e.r >= 10020) {
        throw new Error('El Excel supera el límite de 10.000 estudiantes.');
    }
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false });
    const headersFor = (row) => (row || []).map((value) => normalized(value).replace(/\s+/g, '_'));
    const legacyHeader = (header) => header.includes('NOMBRES_ALUMNO')
        && header.some((name) => /^CURSO(?:_\d{4})?$/.test(name)) && header.includes('LETRA');
    const simpleHeader = (header) => header.includes('CURSO')
        && header.some((name) => studentNameColumns.includes(name));
    const headerIndex = rows.slice(0, 20).findIndex((row) => {
        const header = headersFor(row);
        return legacyHeader(header) || simpleHeader(header);
    });
    if (headerIndex < 0) throw new Error('Faltan las columnas Nombre y Curso o los encabezados del archivo del buscador local.');
    const headers = headersFor(rows[headerIndex]);
    const rutColumn = headers.findIndex((label) => /^(?:RUT|RUN)(?:_(?:DEL_)?(?:ALUMNO|ESTUDIANTE))?$/.test(label));
    const source = rows.slice(headerIndex + 1).filter((row) => row?.some((cell) => clean(cell)));
    const column = (title, fallback) => {
        const index = headers.indexOf(normalized(title).replace(/\s+/g, '_'));
        return index < 0 ? fallback : index;
    };
    const emails = headers.flatMap((header, index) => header === 'CORREO' ? [index] : []);
    if (!legacyHeader(headers)) {
        const first = headers.findIndex((label) => studentNameColumns.includes(label));
        const second = headers.indexOf('CURSO');
        const students = source.map((row) => ({
            name: clean(row[first]), course: normalizeCourse(row[second]), rut: clean(row[rutColumn]),
            academic_name: clean(row[column('APODERADO_ACADÉMICO', -1)]),
            academic_phone: clean(row[column('TELÉFONO_ACADÉMICO', -1)]),
            academic_email: clean(row[column('CORREO_ACADÉMICO', -1)]),
            financial_name: clean(row[column('APODERADO_FINANCIERO', -1)]),
            financial_phone: clean(row[column('TELÉFONO_FINANCIERO', -1)]),
            financial_email: clean(row[column('CORREO_FINANCIERO', -1)])
        }));
        return { students, tutors: [] };
    }
    const columns = {
        first: column('NOMBRES_ALUMNO', 0), last: column('APELLIDO_PATERNO_ALUMNO', 1),
        second: column('APELLIDO_MATERNO_ALUMNO', 2), course: headers.findIndex((name) => /^CURSO(?:_\d{4})?$/.test(name)),
        grade: column('GRADO_ALUMNO', 4), group: column('LETRA', 5),
        acad: column('NOMBRE_ACADEMICO', 6), acadLast: column('APELLIDO_PATERNO_ACADEMICO', 7),
        acadSecond: column('APELLIDO_MATERNO_ACADEMICO', 8), acadPhone: column('TELEFONO', 9),
        acadEmail: emails[0] ?? 10, finance: column('NOMBRE_APOD_DE CUENTAS', 11),
        financeLast: column('APELLIDO_PATERNO_AP.DE CUENTAS', 12),
        financeSecond: column('APELLIDO_MATERNO_AP.DE CUENTAS', 13),
        financePhone: column('TELEFONO_AP.FINANCIERO', 14), financeEmail: emails[1] ?? 15
    };
    const students = source.map((row) => {
        const cell = (key) => clean(row[columns[key]]);
        const join = (...keys) => keys.map(cell).filter(Boolean).join(' ');
        const course = [join('course'), join('grade', 'group'), join('course', 'grade', 'group')];
        const recognized = course.map(normalizeCourse).find((value) => /^[1-8](?:EM)?-[A-Z]$/.test(value));
        return {
            name: cell('first') ? join('first', 'last', 'second') : '', course: recognized || course[0] || course[1],
            rut: clean(row[rutColumn]),
            academic_name: join('acad', 'acadLast', 'acadSecond'), academic_phone: cell('acadPhone'),
            academic_email: cell('acadEmail'), financial_name: join('finance', 'financeLast', 'financeSecond'),
            financial_phone: cell('financePhone'), financial_email: cell('financeEmail')
        };
    });
    return { students, tutors: [] };
}

export async function readRoster(file) {
    if (file.size > 8 * 1024 * 1024) throw new Error('Selecciona un archivo de hasta 8 MB.');
    const roster = file.name.toLowerCase().endsWith('.json')
        ? rosterFromBackup(await file.text()) : rosterFromExcel(await file.arrayBuffer());
    if (!roster.students.length && !roster.tutors.length) throw new Error('El archivo no tiene registros para importar.');
    if (roster.students.length > 10000 || roster.tutors.length > 500) throw new Error('El archivo supera los límites de importación.');
    return roster;
}
