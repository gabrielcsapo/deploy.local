const ITEMS = [
  { id: "a", name: "Sunset print", price: 24 },
  { id: "b", name: "Forest poster", price: 18 },
  { id: "c", name: "Ocean canvas", price: 42 },
];

export default function CartContents() {
  const total = ITEMS.reduce((sum, i) => sum + i.price, 0);
  return (
    <div data-testid="cart-contents">
      <ul className="space-y-3 list-none p-0">
        {ITEMS.map((item) => (
          <li
            key={item.id}
            data-testid={`cart-item-${item.id}`}
            className="flex justify-between text-sm"
          >
            <span>{item.name}</span>
            <span className="text-gray-600">${item.price}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 pt-3 border-t border-gray-200 flex justify-between font-semibold">
        <span>Total</span>
        <span data-testid="cart-total">${total}</span>
      </div>
    </div>
  );
}
