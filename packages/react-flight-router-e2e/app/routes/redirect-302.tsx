import { redirect } from "react-flight-router/server";

export default function Redirect302() {
  redirect("/redirect-destination");
}
