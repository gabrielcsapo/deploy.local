import { Outlet } from "react-flight-router/client";
import CartDrawer from "./cart-drawer.client.js";

export default function CartDrawerSlot() {
  return (
    <CartDrawer>
      <Outlet />
    </CartDrawer>
  );
}
