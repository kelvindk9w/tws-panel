/**
 * modal-a11y.test.tsx — Modal: foco (inicial, preso, devolvido), Escape só no topo, clique fora
 * completo, e bloqueio de fechamento enquanto há requisição em andamento.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal, useModalBusy, useModalLocked } from "@/components/ui/modal";

beforeEach(() => {
  document.body.style.overflow = "";
});
afterEach(cleanup);

function Busy({ on }: { on: boolean }) {
  useModalBusy(on);
  return null;
}

describe("Modal — foco", () => {
  it("foca o primeiro campo, prende o Tab e devolve o foco a quem abriu", () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>abrir</button>
          {open && (
            <Modal title="t" onClose={() => setOpen(false)} footer={<button>ultimo</button>}>
              <input aria-label="campo" />
            </Modal>
          )}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByText("abrir");
    opener.focus();
    fireEvent.click(opener);
    const input = screen.getByLabelText("campo");
    expect(document.activeElement).toBe(input);

    const last = screen.getByText("ultimo");
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "a" });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
  });

  it("sem campo, o foco vai para o painel e o Tab não escapa", () => {
    render(<Modal title="t" onClose={vi.fn()}>só texto</Modal>);
    const panel = screen.getByTestId("modal-panel");
    expect(document.activeElement).toBe(panel);
    expect(fireEvent.keyDown(panel, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(panel);
  });

  it("Shift+Tab no painel vai para o último; elemento removido não quebra a devolução do foco", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<Modal title="t" onClose={vi.fn()} footer={<button>fim</button>}>texto</Modal>);
    opener.remove();
    fireEvent.keyDown(screen.getByTestId("modal-panel"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("fim"));
    expect(() => unmount()).not.toThrow();
  });
});

describe("Modal — fechamento", () => {
  it("só o do topo fecha com Escape, e Escape já tratado (defaultPrevented) é ignorado", () => {
    const a = vi.fn();
    const b = vi.fn();
    render(
      <>
        <Modal title="a" onClose={a}>x</Modal>
        <Modal title="b" onClose={b}>x</Modal>
      </>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    const ev = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
    ev.preventDefault();
    document.dispatchEvent(ev);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("clique fora só fecha se o botão desceu e subiu no fundo", () => {
    const onClose = vi.fn();
    render(<Modal title="t" onClose={onClose}>x</Modal>);
    const overlay = screen.getByTestId("modal-overlay");
    const panel = screen.getByTestId("modal-panel");
    fireEvent.mouseDown(panel);
    fireEvent.mouseUp(overlay);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(panel);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("com busy, Escape e clique fora são ignorados; ao terminar voltam a fechar", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Modal title="t" busy onClose={onClose}>x</Modal>);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(screen.getByTestId("modal-overlay"));
    fireEvent.mouseUp(screen.getByTestId("modal-overlay"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("modal-panel").getAttribute("aria-busy")).toBe("true");
    rerender(<Modal title="t" busy={false} onClose={onClose}>x</Modal>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("um filho em useModalBusy também impede o fechamento enquanto trabalha", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Modal title="t" onClose={onClose}><Busy on /></Modal>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Modal title="t" onClose={onClose}><Busy on={false} /></Modal>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("useModalBusy fora de um Modal não faz nada", () => {
    expect(() => render(<Busy on />)).not.toThrow();
  });
});

describe("Modal — estado travado visível ao rodapé", () => {
  function Footer() {
    const locked = useModalLocked();
    return <button disabled={locked}>cancelar</button>;
  }
  it("o rodapé vê o bloqueio de um filho ocupado (ex.: Cloudflare aplicando) e libera depois", () => {
    const { rerender } = render(<Modal title="t" onClose={vi.fn()} footer={<Footer />}><Busy on /></Modal>);
    expect((screen.getByText("cancelar") as HTMLButtonElement).disabled).toBe(true);
    rerender(<Modal title="t" onClose={vi.fn()} footer={<Footer />}><Busy on={false} /></Modal>);
    expect((screen.getByText("cancelar") as HTMLButtonElement).disabled).toBe(false);
  });
  it("busy do próprio Modal também trava o rodapé; fora de Modal não trava", () => {
    render(<Modal title="t" busy onClose={vi.fn()} footer={<Footer />}>x</Modal>);
    expect((screen.getByText("cancelar") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(<Footer />);
    expect((screen.getByText("cancelar") as HTMLButtonElement).disabled).toBe(false);
  });
  it("returnFocusRef recebe o foco ao fechar, mesmo se o gatilho foi trocado por outro elemento", () => {
    const ref = { current: null as HTMLButtonElement | null };
    const { unmount } = render(<><button ref={(el) => { ref.current = el; }}>gatilho</button><Modal title="t" onClose={vi.fn()} returnFocusRef={ref}>x</Modal></>);
    unmount();
    cleanup();
    const el = document.createElement("button");
    document.body.appendChild(el);
    ref.current = el;
    const m = render(<Modal title="t" onClose={vi.fn()} returnFocusRef={ref}>x</Modal>);
    m.unmount();
    expect(document.activeElement).toBe(el);
    el.remove();
  });
});
