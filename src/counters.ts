let notificationSuccessCount = 0;
let notificationFailureCount = 0;

export function recordNotificationDelivery(success: boolean): void {
  if (success) notificationSuccessCount++;
  else notificationFailureCount++;
}

export function getNotificationMetrics(): { success: number; failure: number } {
  return { success: notificationSuccessCount, failure: notificationFailureCount };
}
