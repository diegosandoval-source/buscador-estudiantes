import { parseMappedSheet, suggestMapping } from './school-records.js?v=15';

const headerKey = (value) => String(value ?? '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

export function readAutomaticRoster(workbook) {
    const candidates = workbook.sheets.flatMap((sheet) => {
        const headers = sheet.rows[sheet.header] ?? [];
        const mapping = suggestMapping(headers);
        // Some exports call the given-name column simply «Nombre» and provide surnames separately.
        if (mapping.given_names < 0 && mapping.name >= 0
            && (mapping.family_first >= 0 || mapping.family_second >= 0)
            && ['NOMBRE', 'NOMBRE_DEL_ALUMNO'].includes(headerKey(headers[mapping.name]))) {
            mapping.given_names = mapping.name;
            mapping.name = -1;
        }
        return mapping.course >= 0 && (mapping.name >= 0 || mapping.given_names >= 0)
            ? [{ sheet, mapping }] : [];
    });
    const general = workbook.sheets.find((sheet) => headerKey(sheet.name) === 'GENERAL');
    let selected;
    if (general) selected = candidates.find(({ sheet }) => sheet === general);
    else if (candidates.length === 1) selected = candidates[0];
    else {
        const bases = candidates.filter(({ sheet }) => ['BASE', 'BASE_DE_DATOS', 'NOMINA', 'ALUMNOS', 'ESTUDIANTES', 'VALIDACION'].includes(headerKey(sheet.name)));
        if (bases.length === 1) selected = bases[0];
    }
    if (!selected) {
        if (!general && candidates.length > 1) {
            throw new Error('El Excel contiene varias hojas de alumnos. Nombra «GENERAL» a la hoja de la base que quieres cargar y vuelve a seleccionar el archivo.');
        }
        throw new Error(`No encontré las columnas del nombre del alumno y del curso${general ? ' en la hoja GENERAL' : ''}. Revisa los encabezados del Excel y vuelve a cargarlo.`);
    }
    const roster = parseMappedSheet(selected.sheet, selected.sheet.header, selected.mapping);
    if (!roster.students.length) throw new Error('La hoja de alumnos no contiene registros completos. Revisa los nombres y cursos del Excel.');
    if (roster.students.length > 10000) throw new Error('La base supera el límite de 10.000 alumnos.');
    return { ...roster, sheetName: selected.sheet.name };
}
