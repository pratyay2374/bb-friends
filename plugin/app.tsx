import { definePluginApp } from "@get-bb/plugin-sdk/app";

import { FriendsPage } from "./components/friends-page";
import { Notifier } from "./components/notifier";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "friends",
    title: "Friends",
    icon: "Users",
    path: "friends",
    component: FriendsPage,
  });
  // Always mounted, renders nothing: turns pokes into toasts.
  app.slots.experimental_appOverlay({ id: "notifier", component: Notifier });
});
