const url = "https://api.googleai.com/v1/translate"; // Замените на реальный endpoint

const requestBody = {
    prompt: 'hey you',
    max_tokens: 150,
};

async function translate() {
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer AIzaSyDoh0ITkgUmDgZ3DxMPrwSVJYPYzZ1YFhU`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log(data);
    } catch (error) {
        console.error('Error:', error);
    }
}

translate();