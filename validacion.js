import { validateCode } from './local-data.js?v=12';
import { validationLabels } from './validation-records.js?v=8';

const form = document.getElementById('public-validation');
const status = document.getElementById('public-status');

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
        const result = await validateCode(form.elements.code.value);
        status.textContent = validationLabels[result];
    } catch (error) {
        status.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});
