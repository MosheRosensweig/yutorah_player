function showToast(message, type, limit = 3000) { // type = success | error
    const toast = document.createElement('div');

    toast.classList.add('toast');
    toast.classList.add(type);
    toast.innerText = message;

    document.body.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, limit);
}
