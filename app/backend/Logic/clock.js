/**
 * Проверяет, идет ли смена в текущий момент.
 * @param {number} startHour - Час начала (0-23)
 * @param {number} endHour - Час окончания (0-23)
 * @param {Date} [now=new Date()] - Время проверки (инжектится для тестов)
 * @returns {boolean}
 */
export default function isWorkShiftStarted(startHour, endHour, now = new Date()) {
  if (typeof startHour !== 'number' || typeof endHour !== 'number') return false;

  const current = now.getHours() * 60 + now.getMinutes();
  const start = startHour * 60;
  const end = endHour * 60;

  if (start <= end) {
    return current >= start && current < end;
  } else {
    return current >= start || current < end;
  }
}