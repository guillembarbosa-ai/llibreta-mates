document.addEventListener('DOMContentLoaded', () => {
  // Selecció visual del rol al formulari de registre
  document.querySelectorAll('.role-option').forEach((option) => {
    const input = option.querySelector('input[type="radio"]');
    if (!input) return;
    const update = () => {
      document.querySelectorAll('.role-option').forEach((other) => other.classList.remove('selected'));
      if (input.checked) option.classList.add('selected');
    };
    input.addEventListener('change', update);
    update();
  });

  // Confirmació per a accions destructives
  document.querySelectorAll('[data-confirm]').forEach((element) => {
    element.addEventListener('submit', (event) => {
      if (!window.confirm(element.dataset.confirm)) event.preventDefault();
    });
  });

  // Tanca el menú d'usuari en clicar fora
  document.querySelectorAll('.user-menu').forEach((menu) => {
    document.addEventListener('click', (event) => {
      if (!menu.contains(event.target)) menu.open = false;
    });
  });

  // Tanca les alertes en clicar-les
  document.querySelectorAll('.alert').forEach((alert) => {
    alert.style.cursor = 'pointer';
    alert.addEventListener('click', () => alert.remove());
  });
});
