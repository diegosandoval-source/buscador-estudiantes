import { normalizeCourse, normalized } from './student-import.js?v=15';

export const validationLabels = { vigente: 'Vigente', vencido: 'Vencido', anulado: 'Anulado', no_existe: 'Sin folio autorizado' };

export function normalizeRut(value) {
    return String(value ?? '').trim().toUpperCase().replace(/[.\s-]/g, '');
}

export function displayRut(value) {
    const compact = normalizeRut(value);
    return compact ? compact.slice(0, -1) + '-' + compact.slice(-1) : '';
}

function studentNameKey(student) {
    return normalized(student.name) + '\u0000' + normalized(student.course);
}

export function resolveStudent(students, input, requestedId = '') {
    if (requestedId) {
        const selected = students.find(({ id }) => id === requestedId);
        if (!selected) throw new Error('La ficha seleccionada ya no está disponible.');
        return selected;
    }
    const rut = normalizeRut(input.rut);
    if (rut) {
        if (!/^\d{1,8}[\dK]$/.test(rut)) throw new Error('Revisa el formato del RUT.');
        const match = students.find((student) => normalizeRut(student.rut) === rut);
        if (match) return match;
    }
    const name = [input.given_names, input.family_names].map((part) => part.trim()).filter(Boolean).join(' ');
    if (!input.given_names.trim() || !input.family_names.trim()) throw new Error('Completa el nombre y los apellidos.');
    const draft = {
        given_names: input.given_names.trim(), family_names: input.family_names.trim(),
        name, course: normalizeCourse(input.course), rut
    };
    const matches = students.filter((student) => (draft.course ? studentNameKey(student) === studentNameKey(draft)
        : normalized(student.name) === normalized(draft.name))
        && (!rut || !student.rut || normalizeRut(student.rut) === rut));
    if (matches.length > 1) throw new Error('Hay más de una ficha con esos datos. Búscala y agrégale la validación desde su ficha.');
    return matches[0] ?? { ...draft, id: crypto.randomUUID() };
}

export function validationFromForm(fields, studentId, previous, canPublish, makeCode) {
    const code = fields.code.trim() || previous?.code || makeCode();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._/-]{0,63}$/u.test(code)) throw new Error('Revisa el código o folio.');
    const type = fields.type.trim();
    if (!type) throw new Error('Completa el tipo de validación.');
    const issuedOn = fields.issuedOn;
    const expiresOn = fields.expiresOn || null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedOn)) throw new Error('Ingresa la fecha de emisión.');
    if (expiresOn && (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) || expiresOn < issuedOn)) {
        throw new Error('La fecha de vencimiento debe ser igual o posterior a la de emisión.');
    }
    if (!['vigente', 'vencido', 'anulado'].includes(fields.state)) throw new Error('Selecciona un estado válido.');
    const published = canPublish && fields.published;
    return {
        id: previous?.id ?? crypto.randomUUID(), studentId, code, type, issuedOn, expiresOn,
        state: fields.state, notes: fields.notes.trim(), published,
        publicCode: published ? previous?.publicCode || makeCode() : previous?.publicCode ?? ''
    };
}

export function studentMatches(student, validations, value) {
    const words = normalized(value).split(/\s+/).filter(Boolean);
    const affiliations = [student.name, student.course, student.academic_name, student.financial_name,
        student.rut, displayRut(student.rut), ...validations.flatMap(({ code, publicCode }) => [code, publicCode])];
    const haystack = normalized(affiliations.join(' '));
    return words.every((word) => haystack.includes(word)
        || (/[.\-]/.test(word) && student.rut && normalizeRut(student.rut).includes(normalizeRut(word))));
}
