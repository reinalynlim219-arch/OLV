(() => {
    const dialog = document.getElementById("receiptDialog");
    const form = document.getElementById("receiptForm");
    const fileInput = document.getElementById("receiptPhoto");
    const preview = document.getElementById("receiptPreview");
    const message = document.getElementById("receiptMessage");
    const submit = document.getElementById("receiptSubmit");
    const noPhotoPrompt = document.getElementById("receiptNoPhotoPrompt");
    const yesButton = document.getElementById("receiptNoPhotoYes");
    let allowWithoutPhoto = false;
    function resetPhotoConfirmation() {
        allowWithoutPhoto = false;
        noPhotoPrompt.classList.add("d-none");
        submit.classList.remove("d-none");
    }
    yesButton.addEventListener("click", () => {
        allowWithoutPhoto = true;
        noPhotoPrompt.classList.add("d-none");
        submit.classList.remove("d-none");
        form.requestSubmit(submit);
    });
    document.getElementById("receiptNoPhotoNo").addEventListener("click", () => {
        resetPhotoConfirmation();
        message.textContent = "You can attach a photo or cancel. Receipt has not been confirmed.";
        fileInput.focus();
    });
    let deliveryId, photoOnly, photoSaved, busy = false;
    const cameraButton = document.getElementById("receiptCameraButton");
    const camera = document.getElementById("receiptCamera");
    cameraButton.addEventListener("click", () => camera.click());
    camera.addEventListener("change", () => {
        if (camera.files.length) {
            fileInput.files = camera.files;
            fileInput.dispatchEvent(new Event("change"));
        }
    });

    window.openReceiptDialog = (id, onlyPhoto = false, hasPhoto = false) => {
        deliveryId = id;
        photoOnly = onlyPhoto;
        photoSaved = hasPhoto;
        form.reset();
        resetPhotoConfirmation();
        preview.removeAttribute("src");
        preview.classList.add("d-none");
        fileInput.disabled = hasPhoto;
        cameraButton.disabled = hasPhoto;
        message.textContent = hasPhoto ? "Your receipt photo is already saved." : "";
        document.getElementById("receiptTitle").textContent = onlyPhoto ? "Add receipt photo" : "Confirm order received";
        submit.textContent = onlyPhoto ? "Save photo" : "Confirm received";
        dialog.showModal();
    };

    async function preparePhoto(file) {
        if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
        if (file.size > 10 * 1024 * 1024) throw new Error("Choose a photo smaller than 10 MB.");
        const dataURL = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("Unable to read photo."));
            reader.readAsDataURL(file);
        });
        const img = new Image();
        img.src = dataURL;
        try { await img.decode(); } catch (_) { throw new Error("Unable to open this image. Choose another photo."); }
        const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const photo = canvas.toDataURL("image/jpeg", .75);
        if (photo.length > 900000) throw new Error("This photo is too detailed. Choose a smaller image.");
        return photo;
    }

    fileInput.addEventListener("change", async () => {
        resetPhotoConfirmation();
        const file = fileInput.files[0];
        preview.classList.add("d-none");
        message.textContent = "";
        if (!file) return;
        try {
            const photo = await preparePhoto(file);
            if (fileInput.files[0] !== file || !dialog.open) return;
            preview.src = photo;
            preview.classList.remove("d-none");
        } catch (error) { message.textContent = error.message; }
    });
    document.getElementById("receiptCancel").addEventListener("click", () => { if (!busy) dialog.close(); });
    dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
    dialog.addEventListener("close", () => { form.reset(); preview.removeAttribute("src"); });
    form.addEventListener("submit", async event => {
        event.preventDefault();
        if (busy) return;
        if (!photoOnly && !photoSaved && !fileInput.files[0] && !allowWithoutPhoto) {
            message.textContent = "";
            noPhotoPrompt.classList.remove("d-none");
            submit.classList.add("d-none");
            document.getElementById("receiptNoPhotoNo").focus();
            return;
        }
        allowWithoutPhoto = false;
        busy = true;
        submit.disabled = true;
        fileInput.disabled = true;
        cameraButton.disabled = true;
        document.getElementById("receiptCancel").disabled = true;
        message.textContent = "Saving...";
        try {
            if (!photoSaved && fileInput.files[0]) {
                const photo = await preparePhoto(fileInput.files[0]);
                const response = await fetch("/api/customer/delivery/photo", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ delivery_id: deliveryId, photo })
                });
                const data = await response.json();
                if (!response.ok && response.status !== 409) throw new Error(data.message || "Unable to save photo.");
                photoSaved = true;
            }
            if (photoOnly && !photoSaved) throw new Error("Choose a photo to attach.");
            if (!photoOnly) {
                const response = await fetch("/api/customer/delivery/received", {
                    method: "PUT", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ delivery_id: deliveryId })
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.message || "Unable to confirm receipt.");
            }
            dialog.close();
            showMessage(photoOnly ? "Receipt photo saved." : photoSaved ? "Receipt photo saved. Order received and completed." : "Order received and completed without a photo.");
            await loadOrders();
        } catch (error) {
            message.textContent = `${photoSaved ? "Your photo is saved. " : ""}${error.message}`;
        } finally {
            busy = false;
            submit.disabled = false;
            fileInput.disabled = photoSaved;
            cameraButton.disabled = photoSaved;
            document.getElementById("receiptCancel").disabled = false;
        }
    });
})();
