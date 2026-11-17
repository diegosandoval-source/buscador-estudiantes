import { normalizeCourse, normalized } from './student-import.js?v=15';
import { normalizeRut } from './validation-records.js?v=15';

export const comparisonLabels = {
    validado: 'Validado', diferencias: 'Con diferencias',
    no_encontrado: 'No encontrado', pendiente: 'Pendiente de revisión'
};

export const importFields = [
    { key: 'name', label: 'Nombre completo del alumno', aliases: ['NOMBRE', 'NOMBRE_COMPLETO', 'ALUMNO', 'ESTUDIANTE', 'NOMBRE_DEL_ALUMNO'] },
    { key: 'given_names', label: 'Nombres del alumno', aliases: ['NOMBRES_ALUMNO', 'NOMBRES', 'NOMBRE_ALUMNO'] },
    { key: 'family_first', label: 'Apellido paterno del alumno', aliases: ['APELLIDO_PATERNO_ALUMNO', 'APELLIDO_PATERNO', 'PRIMER_APELLIDO'] },
    { key: 'family_second', label: 'Apellido materno del alumno', aliases: ['APELLIDO_MATERNO_ALUMNO', 'APELLIDO_MATERNO', 'SEGUNDO_APELLIDO'] },
    { key: 'rut', label: 'RUT del alumno', aliases: ['RUT_ALUMNO', 'RUT_ESTUDIANTE', 'RUT_DEL_ALUMNO', 'RUN_ALUMNO', 'RUT', 'RUN'] },
    { key: 'course', label: 'Curso', aliases: ['CURSO', 'CURSO_2026', 'CURSO_2027'] },
    { key: 'level', label: 'Nivel o enseñanza', aliases: ['GRADO_ALUMNO', 'NIVEL', 'ENSENANZA'] },
    { key: 'section', label: 'Letra o sección', aliases: ['LETRA', 'SECCION', 'PARALELO'] },
    { key: 'tutor', label: 'Profesor tutor o jefe', aliases: ['PROFESOR_JEFE', 'PROFESOR_TUTOR', 'PROFESOR', 'TUTOR', 'DOCENTE'] },
    { key: 'tutor_email', label: 'Correo del profesor tutor', aliases: ['CORREO_TUTOR', 'EMAIL_TUTOR', 'CORREO_PROFESOR', 'CORREO_DOCENTE'] },
    { key: 'academic_name', label: 'Nombres del apoderado académico', contacts: true, aliases: ['NOMBRE_ACADEMICO', 'APODERADO_ACADEMICO'] },
    { key: 'academic_first', label: 'Apellido paterno del apoderado académico', contacts: true, aliases: ['APELLIDO_PATERNO_ACADEMICO'] },
    { key: 'academic_second', label: 'Apellido materno del apoderado académico', contacts: true, aliases: ['APELLIDO_MATERNO_ACADEMICO'] },
    { key: 'academic_phone', label: 'Teléfono del apoderado académico', contacts: true, aliases: ['TELEFONO_ACADEMICO', 'TELEFONO'] },
    { key: 'academic_email', label: 'Correo del apoderado académico', contacts: true, aliases: ['CORREO_ACADEMICO', 'CORREO'] },
    { key: 'financial_name', label: 'Nombres del apoderado de cuentas', contacts: true, aliases: ['NOMBRE_APOD_DE_CUENTAS', 'APODERADO_FINANCIERO'] },
    { key: 'financial_first', label: 'Apellido paterno del apoderado de cuentas', contacts: true, aliases: ['APELLIDO_PATERNO_AP_DE_CUENTAS'] },
    { key: 'financial_second', label: 'Apellido materno del apoderado de cuentas', contacts: true, aliases: ['APELLIDO_MATERNO_AP_DE_CUENTAS', 'APELLIDO_MATERNO_AP_DE_CUNTAS'] },
    { key: 'financial_phone', label: 'Teléfono del apoderado de cuentas', contacts: true, aliases: ['TELEFONO_AP_FINANCIERO', 'TELEFONO_FINANCIERO'] },
    { key: 'financial_email', label: 'Correo del apoderado de cuentas', contacts: true, aliases: ['CORREO_FINANCIERO'], occurrence: 1 }
];

const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const headerKey = (value) => normalized(value).replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
const nameKey = (value) => normalized(value).replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function rutIdentity(value) {
    const rut = normalizeRut(value);
    if (!/^\d{1,8}[\dK]$/.test(rut)) return '';
    const body = rut.slice(0, -1).replace(/^0+(?=\d)/, '');
    if (/^0+$/.test(body)) return '';
    let sum = 0;
    let factor = 2;
    for (const digit of Array.from(body).reverse()) {
        sum += Number(digit) * factor;
        factor = factor === 7 ? 2 : factor + 1;
    }
    const remainder = 11 - sum % 11;
    const expected = remainder === 11 ? '0' : remainder === 10 ? 'K' : String(remainder);
    return rut.at(-1) === expected ? body + expected : '';
}

export function suggestMapping(headers) {
    const keys = headers.map(headerKey);
    const mapping = Object.fromEntries(importFields.map((field) => {
        let index = keys.findIndex((key) => field.aliases.includes(key));
        if (field.key === 'course' && index < 0) index = keys.findIndex((key) => /^CURSO_\d{4}$/.test(key));
        if (field.key === 'financial_email' && index < 0) {
            index = keys.flatMap((key, position) => key === 'CORREO' ? [position] : [])[1] ?? -1;
        }
        return [field.key, index];
    }));
    if (mapping.given_names >= 0) mapping.name = -1;
    return mapping;
}

export async function inspectWorkbook(file) {
    if (!/\.(xlsx|xls)$/i.test(file.name) || file.size > 8 * 1024 * 1024) {
        throw new Error('Selecciona un Excel .xlsx o .xls de hasta 8 MB.');
    }
    if (!globalThis.XLSX) throw new Error('No se cargó el lector de Excel. Recarga la página.');
    const book = XLSX.read(await file.arrayBuffer(), { type: 'array', sheetRows: 10021 });
    const sheets = book.SheetNames.map((name) => {
        const sheet = book.Sheets[name];
        if (sheet['!fullref'] && XLSX.utils.decode_range(sheet['!fullref']).e.r >= 10020) {
            throw new Error('Una hoja supera el límite de 10.000 registros.');
        }
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
        let header = 0;
        let bestScore = -1;
        for (let position = 0; position < Math.min(rows.length, 20); position++) {
            const mapping = suggestMapping(rows[position]);
            const score = Object.values(mapping).filter((index) => index >= 0).length;
            if (score > bestScore) { bestScore = score; header = position; }
        }
        return { name, rows, header };
    }).filter((sheet) => sheet.rows.length);
    if (!sheets.length) throw new Error('El Excel no contiene registros.');
    return { name: file.name, sheets };
}

export function parseMappedSheet(sheet, header, mapping) {
    if (!Number.isInteger(header) || header < 0 || header >= sheet.rows.length) throw new Error('Revisa la fila de encabezados.');
    if (Number(mapping.course) < 0) throw new Error('Selecciona la columna del curso.');
    const hasStudents = Number(mapping.name) >= 0 || Number(mapping.given_names) >= 0 || Number(mapping.rut) >= 0;
    if (!hasStudents && Number(mapping.tutor) < 0) throw new Error('Selecciona el profesor tutor o las columnas de alumnos.');
    const students = [];
    const tutors = new Map();
    let omitted = 0;
    for (let offset = header + 1; offset < sheet.rows.length; offset++) {
        const row = sheet.rows[offset];
        if (!row.some((value) => clean(value))) continue;
        const field = (key) => Number(mapping[key]) >= 0 ? clean(row[Number(mapping[key])]) : '';
        const join = (...keys) => keys.map(field).filter(Boolean).join(' ');
        const composite = join('course', 'level', 'section');
        const direct = normalizeCourse(field('course'));
        const recognized = direct.match(/^([1-8])(EM)?-([A-Z])$/);
        const medium = Boolean(recognized?.[2]) || /MEDI|\bEM\b/i.test(field('level'));
        const course = recognized && !field('section')
            ? `${recognized[1]}${medium ? 'EM' : ''}-${recognized[3]}` : normalizeCourse(composite);
        if (!course || course.length > 80) { omitted++; continue; }
        const tutor = field('tutor');
        const tutorEmail = field('tutor_email');
        if (tutor.length > 200 || tutorEmail.length > 254) { omitted++; continue; }
        if (tutor) {
            const previous = tutors.get(course);
            if (previous && nameKey(previous.name) !== nameKey(tutor)) {
                throw new Error('El archivo asigna más de un profesor al mismo curso. Revisa la hoja y las columnas seleccionadas.');
            }
            tutors.set(course, { course, name: tutor, email: tutorEmail });
        }
        if (!hasStudents) continue;
        const name = field('name') || join('given_names', 'family_first', 'family_second');
        if (!name || name.length > 200) { omitted++; continue; }
        students.push({
            name, course, rut: normalizeRut(field('rut')), tutor,
            given_names: field('given_names'), family_names: join('family_first', 'family_second'),
            academic_name: join('academic_name', 'academic_first', 'academic_second'),
            academic_phone: field('academic_phone').slice(0, 80), academic_email: field('academic_email').slice(0, 254),
            financial_name: join('financial_name', 'financial_first', 'financial_second'),
            financial_phone: field('financial_phone').slice(0, 80), financial_email: field('financial_email').slice(0, 254),
            sourceRow: offset + 1
        });
    }
    if (!students.length && !tutors.size) throw new Error('No hay alumnos ni profesores importables con estas columnas.');
    return { students, tutors: Array.from(tutors.values()), omitted };
}

export function mergeImportedStudents(previous, imported) {
    const students = previous.map((student) => ({ ...student }));
    const seenInFile = new Map();
    let added = 0;
    let updated = 0;
    let conflicts = 0;
    for (const row of imported) {
        const rut = rutIdentity(row.rut);
        const key = rut || nameKey(row.name) + '|' + normalizeCourse(row.course);
        const signature = nameKey(row.name) + '|' + normalizeCourse(row.course);
        const repeated = seenInFile.get(key);
        if (repeated) {
            if (repeated.signature !== signature) { repeated.record.sourceConflict = true; conflicts++; }
            continue;
        }
        const matches = students.filter((student) => rut ? rutIdentity(student.rut) === rut
            : nameKey(student.name) === nameKey(row.name) && normalizeCourse(student.course) === normalizeCourse(row.course));
        if (matches.length > 1) { conflicts++; matches.forEach((student) => { student.sourceConflict = true; }); continue; }
        const record = matches[0];
        const values = {
            ...Object.fromEntries(Object.entries(row).filter(([, value]) => value !== '')),
            comparisonRut: row.rut ?? '', sourceConflict: false
        };
        if (record) {
            Object.assign(record, values);
            updated++;
            seenInFile.set(key, { record, signature });
        } else {
            const created = { ...values, id: crypto.randomUUID() };
            students.push(created);
            seenInFile.set(key, { record: created, signature });
            added++;
        }
    }
    return { students, added, updated, conflicts };
}

export function compareStudent(student, referenceStudents, tutors) {
    const courseMap = new Map(tutors.map((tutor) => [normalizeCourse(tutor.course), tutor.name]));
    const suppliedRut = student.comparisonRut ?? student.rut;
    const identity = rutIdentity(suppliedRut);
    const byIdentity = identity ? referenceStudents.filter((row) => rutIdentity(row.rut) === identity) : [];
    const byName = referenceStudents.filter((row) => nameKey(row.name) === nameKey(student.name));
    const reference = byIdentity.length === 1 ? byIdentity[0] : !identity && byName.length === 1 ? byName[0] : null;
    const expectedTutor = reference ? courseMap.get(normalizeCourse(reference.course)) || reference.tutor || '' : '';
    const submittedTutor = courseMap.get(normalizeCourse(student.course)) || student.tutor || '';
    const fields = [
        { key: 'name', label: 'Nombre', reference: reference?.name ?? '', submitted: student.name },
        { key: 'rut', label: 'RUT', reference: reference?.rut ?? '', submitted: suppliedRut ?? '' },
        { key: 'course', label: 'Curso', reference: reference?.course ?? '', submitted: student.course ?? '' },
        { key: 'tutor', label: 'Profesor tutor', reference: expectedTutor, submitted: student.tutor || submittedTutor }
    ].map((field) => ({ ...field, different: Boolean(field.reference && field.submitted
        && (field.key === 'rut' ? normalizeRut(field.reference) !== normalizeRut(field.submitted)
            : field.key === 'course' ? normalizeCourse(field.reference) !== normalizeCourse(field.submitted)
                : nameKey(field.reference) !== nameKey(field.submitted))) }));
    const reasons = [];
    let status;
    if (!referenceStudents.length) {
        status = 'pendiente';
        reasons.push('Falta una nómina de referencia de estudiantes. Los cursos y tutores por sí solos no acreditan identidad.');
    } else if (!identity) {
        status = 'pendiente';
        reasons.push(suppliedRut ? 'El RUT no tiene un dígito verificador válido.' : 'Falta un RUT confiable en los datos ingresados para acreditar la identidad.');
        if (byName.length > 1) reasons.push('Hay más de una coincidencia por nombre.');
        if (byName.length === 1) reasons.push('La coincidencia por nombre se muestra como referencia para revisión manual.');
    } else if (byIdentity.length > 1) {
        status = 'pendiente';
        reasons.push('El RUT aparece más de una vez en la nómina de referencia.');
    } else if (!reference) {
        status = 'no_encontrado';
        reasons.push('El RUT no aparece en la nómina de referencia.');
    } else {
        const missing = fields.filter((field) => ['name', 'course'].includes(field.key) && (!field.reference || !field.submitted));
        status = missing.length ? 'pendiente' : fields.some((field) => field.different) ? 'diferencias' : 'validado';
        if (missing.length) reasons.push('Faltan datos de nombre o curso para completar la comparación.');
    }
    if (student.sourceConflict) {
        status = 'pendiente';
        reasons.push('La carga contiene datos contradictorios para este estudiante.');
    }
    return { studentId: student.id, status, fields, reasons, referenceId: reference?.id ?? '', tutor: submittedTutor };
}

export function withComparisons(data, before, at = new Date().toISOString(), force = false) {
    const previous = new Map((before.comparisons ?? []).map((row) => [row.studentId, row]));
    const history = [...(data.comparisonHistory ?? [])];
    const comparisons = data.students.map((student) => {
        const result = compareStudent(student, data.referenceStudents ?? [], data.tutors);
        const old = previous.get(student.id);
        const identity = (entry) => JSON.stringify({ fields: entry.fields, reasons: entry.reasons, referenceId: entry.referenceId });
        const unchanged = old && identity(old) === identity(result);
        if (!force && unchanged) return old;
        const current = { ...result, ...(unchanged && old.review ? { status: old.status, review: old.review } : {}),
            id: crypto.randomUUID(), comparedAt: at };
        if (old) history.push(old);
        return current;
    });
    return { ...data, comparisons, comparisonHistory: history };
}

export function courseSummaries(data) {
    const comparisons = new Map((data.comparisons ?? []).map((entry) => [entry.studentId, entry]));
    const tutors = new Map(data.tutors.map((tutor) => [normalizeCourse(tutor.course), tutor.name]));
    const courses = new Map(data.tutors.map((tutor) => [normalizeCourse(tutor.course), {
        course: normalizeCourse(tutor.course), tutor: tutor.name, total: 0, validado: 0, diferencias: 0, no_encontrado: 0, pendiente: 0
    }]));
    for (const student of data.students) {
        const course = normalizeCourse(student.course) || 'Sin curso';
        if (!courses.has(course)) courses.set(course, { course, tutor: tutors.get(course) || '', total: 0,
            validado: 0, diferencias: 0, no_encontrado: 0, pendiente: 0 });
        const result = courses.get(course);
        result.total++;
        result[comparisons.get(student.id)?.status ?? 'pendiente']++;
    }
    return Array.from(courses.values()).sort((a, b) => a.course.localeCompare(b.course, 'es', { numeric: true }));
}
