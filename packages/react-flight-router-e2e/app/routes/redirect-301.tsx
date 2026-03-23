import { redirect } from "react-flight-router/server";

export default function Redirect301() {
  redirect("/redirect-destination", 301);
}
