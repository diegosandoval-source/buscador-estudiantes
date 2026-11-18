import { normalizeCourse, normalized } from './student-import.js?v=15';
import { normalizeRut } from './validation-records.js?v=15';
import { rutIdentity } from './school-records.js?v=15';

const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');
const nameKey = (value) => normalized(value).replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const identity = (record) => rutIdentity(record.rut) || normalizeRut(record.rut);

function fullName(record) {
    const name = clean(record.name);
    const given = clean(record.given_names);
    return given && clean(record.family_names) && (!name || nameKey(name) === nameKey(given))
        ? clean(given + ' ' + record.family_names) : name;
}

function sameContact(first, second) {
    const firstEmail = clean(first.academic_email).toLowerCase();
    const secondEmail = clean(second.academic_email).toLowerCase();
    const firstPhone = clean(first.academic_phone).replace(/\D/g, '');
    const secondPhone = clean(second.academic_phone).replace(/\D/g, '');
    return Boolean((firstEmail && firstEmail === secondEmail)
        || (firstPhone.length >= 7 && firstPhone === secondPhone));
}

function sameName(first, second) {
    const firstName = nameKey(first.name);
    const secondName = nameKey(second.name);
    if (!firstName || !secondName) return false;
    if (firstName === secondName) return true;
    // A short old import must equal the documented given names of the full entry.
    // A shared first name or an arbitrary name prefix is insufficient.
    const abbreviated = (short, complete) => !clean(short.family_names)
        && nameKey(short.name) === nameKey(complete.given_names)
        && Boolean(clean(complete.family_names))
        && nameKey(complete.name) === nameKey(complete.given_names + ' ' + complete.family_names);
    return abbreviated(first, second) || abbreviated(second, first);
}

function compatible(record, group) {
    const suppliedRut = identity(record);
    return group.members.every((member) => !suppliedRut || !identity(member) || suppliedRut === identity(member));
}

function samePerson(record, group) {
    if (!compatible(record, group)) return false;
    const rut = rutIdentity(record.rut);
    if (rut && group.members.some((member) => rutIdentity(member.rut) === rut)) return true;
    return group.members.some((member) => normalizeCourse(record.course) === normalizeCourse(member.course)
        && Boolean(clean(record.course)) && sameName(record, member) && sameContact(record, member));
}

function completeness(record) {
    return Object.values(record).filter((value) => typeof value === 'string' && clean(value)).length;
}

export function buildStudentSearchIndex(records) {
    // This is a presentation index. Original fichas and their IDs remain intact.
    const ordered = records.map((record) => ({ ...record, name: fullName(record) }));
    ordered.sort((first, second) => second.name.split(' ').length - first.name.split(' ').length
        || completeness(second) - completeness(first));
    const groups = [];
    const byCourse = new Map();
    const byRut = new Map();
    for (const record of ordered) {
        const course = normalizeCourse(record.course);
        const rut = rutIdentity(record.rut);
        const identified = rut ? byRut.get(rut) : null;
        const candidates = identified ? [identified] : (byCourse.get(course) ?? []).filter((group) => samePerson(record, group));
        const group = candidates.length === 1 && compatible(record, candidates[0]) ? candidates[0] : null;
        if (group) {
            group.members.push(record);
            for (const [key, value] of Object.entries(record)) {
                if (!clean(group.student[key]) && clean(value)) group.student[key] = value;
            }
            if (rut) byRut.set(rut, group);
        } else {
            const created = { student: { ...record }, members: [record] };
            groups.push(created);
            if (!byCourse.has(course)) byCourse.set(course, []);
            byCourse.get(course).push(created);
            if (rut) byRut.set(rut, created);
        }
    }
    const byId = new Map(groups.flatMap((group) => group.members.map((record) => [record.id, group])));
    return { source: records, groups, byId };
}
