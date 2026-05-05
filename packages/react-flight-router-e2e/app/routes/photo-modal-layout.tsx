import { Outlet } from "react-flight-router/client";
import PhotoModal from "./photo-modal.client.js";

export default function PhotoModalSlot() {
  return (
    <PhotoModal>
      <Outlet />
    </PhotoModal>
  );
}
