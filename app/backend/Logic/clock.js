/**
 * Проверяет, идет ли смена в текущий момент.
 * @param {number} startHour - Час начала (0-23)
 * @param {number} endHour - Час окончания (0-23)
 * @param {Date} [now=new Date()] - Время проверки (инжектится для тестов)
 * @returns {boolean}
 */
export default function isWorkShiftStarted(startHour, endHour, now = new Date()) {
  if (typeof startHour !== 'number' || typeof endHour !== 'number') return false;
  
  const currentHour = now.getHours();
  
  // Смена может переходить через полночь (на всякий случай)
  if (startHour <= endHour) {
    return currentHour >= startHour && currentHour <= endHour;
  } else {
    // Напр. 22:00 - 06:00
    return currentHour >= startHour || currentHour <= endHour;
  }
}