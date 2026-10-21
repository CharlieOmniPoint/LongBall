import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export interface LocalWarningPlan {
  revision: string;
  dueInMs: number;
  running: boolean;
  owner?: string;
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function ensureChannel() {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("longball-match", {
      // Android NotificationManager.IMPORTANCE_HIGH; SDK exports its enum through platform files.
      name: "LongBall match reminders",
      importance: 4,
      sound: "default",
      vibrationPattern: [0, 250],
    });
  }
}

export async function getAlertCapability(): Promise<string> {
  const permission = await Notifications.getPermissionsAsync();
  return permission.granted
    ? "Local notifications permitted; device lock/Focus delivery still needs testing."
    : "Local notifications are not permitted. Keep the visual match console open.";
}

export async function requestAlertPermission(): Promise<string> {
  await ensureChannel();
  const permission = await Notifications.requestPermissionsAsync();
  return permission.granted
    ? "Local notifications permitted; device delivery is unverified."
    : "Permission was not granted. The visual console remains available.";
}

async function cancelOwned(owner: string) {
  const existing = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    existing
      .filter(
        (request) =>
          request.content.data?.longballM0 === true &&
          (request.content.data.longballOwner === owner ||
            (owner === "m0" &&
              request.content.data.longballOwner === undefined)),
      )
      .map((request) =>
        Notifications.cancelScheduledNotificationAsync(request.identifier),
      ),
  );
}

let queue: Promise<unknown> = Promise.resolve();

/** Pause, half-time and replan use running:false. Missed warning boundaries are never replayed. */
export function replaceLocalWarnings(plan: LocalWarningPlan): Promise<void> {
  const owner = plan.owner ?? "m0";
  if (!/^[a-zA-Z0-9_-]{1,250}$/.test(owner))
    return Promise.reject(
      new Error("A stable reminder owner identifier is required."),
    );
  const { revision, running, dueInMs } = plan;
  const work = queue
    .catch(() => {})
    .then(async () => {
      await cancelOwned(owner);
      if (!running || dueInMs <= 0) return;
      const permission = await Notifications.getPermissionsAsync();
      if (!permission.granted) return;
      await ensureChannel();
      try {
        for (const secondsRemaining of [90, 60, 30, 0]) {
          const seconds = (dueInMs - secondsRemaining * 1000) / 1000;
          if (seconds <= 0) continue;
          await Notifications.scheduleNotificationAsync({
            identifier: `longball-${owner.length}-${owner}-${revision.length}-${revision}-${secondsRemaining}`,
            content: {
              title: secondsRemaining
                ? `Change due in ${secondsRemaining} seconds`
                : "Planned change is due",
              body: "Review the lineup and confirm any change. A reminder never makes a substitution.",
              sound: "default",
              data: { longballM0: true, longballOwner: owner, revision },
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
              seconds: Math.max(1, seconds),
              channelId: "longball-match",
            },
          });
        }
      } catch (error) {
        await cancelOwned(owner);
        throw error;
      }
    });
  queue = work;
  return work;
}
