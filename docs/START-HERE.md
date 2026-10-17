# Put EchoSphere in front of the judges

There are two separate setups. The first lets the coding environment test speech models. The second puts the actual app on the internet. Judges use the second one.

## 1. Allow the cloud environment to test the speech models

1. In Codex, open the **project-zero environment settings**. This is the page with **Scripts**, **Internet access**, and **Network secrets** from your screenshots.
2. Leave **Allow Codex to access internet** switched on.
3. Under **Additional allowed domains**, click the pencil/edit button.
4. Keep the existing Evolus entries. Check that the following model hosts are present. Enter hostnames only, without `https://` or a path:

   ```text
   api.evolus.ai
   app.evolus.ai
   huggingface.co
   *.huggingface.co
   *.hf.co
   cdn.jsdelivr.net
   ```

5. The prepared draft also includes `www.youtube.com` and `www.twitch.tv` for the supplied kickoff links. The pasted transcript already lets us interpret the rules; video access is not needed to run EchoSphere.
6. Leave **EVOLUS_API_KEY** under Network secrets. Its destination should remain the exact hostname `api.evolus.ai`; do not bind that key to the model-download or video sites.
7. Click **Save draft**, then **Publish** if that control is shown. Wait for the environment update to finish. Saving a draft alone does not prove the running machine has the new access.
8. Return to the chat and say **“Network settings published.”** The agent can then retry the actual model download and run `npm run test:models`.

You do not need to install Whisper, Kokoro, or Evolus Studio. Model weights download automatically inside the browser. The cloud check tests that code; it does not create a public website.

## 2. Create the website judges will open

1. Open **[Deploy EchoSphere on Render](https://render.com/deploy?repo=https://github.com/sg01-stack/project-zero)**.
2. Sign up or sign in. Choose **GitHub** when offered.
3. If Render asks to connect GitHub, allow access to **sg01-stack/project-zero**. It needs permission to read the code and deploy future pushes.
4. Render should read the repository's `render.yaml` and propose a web service named **echosphere**. If it asks for a Blueprint name, use **EchoSphere**. Keep branch **main**. Keep the supplied build/start commands.
5. When it asks for **EVOLUS_API_KEY**, paste your working Evolus key into **Render's private environment-variable/secret field**. Do not put it in GitHub or chat. Keep the supplied **EVOLUS_AGENT_ID** unchanged.
6. Click the create/deploy button. Render's exact label may be **Deploy Blueprint** or **Apply**. Wait for the service status to become **Live**. Build progress appears in its logs.
7. Open the **HTTPS website address displayed on the service page**, ending in `.onrender.com`. Copy that actual address. The Render dashboard address is not the demo URL.
8. On the site, open **Story & controls**, then **Test agent connection**. A successful test shows a real response. If it fails, check the Render key and that your AMD-hosted model is still running and connected in Evolus.
9. Click **Click to Initialize.**, allow the microphone, and use headphones. Let the browser finish downloading its models. After **Ready**, stay quiet for 1.2 seconds. The guide begins, and you can interrupt it by speaking.
10. Try the two example inputs under **One world. Two different inputs.** Check the recognized words during a real whisper, the spoken reply, and the automatic placement. Send the actual HTTPS address back in chat so the deployed service can also be checked.

If the Blueprint screen does not appear: in Render choose **New → Blueprint**, connect `sg01-stack/project-zero`, select `main`, and use the `render.yaml` in the repository root. Do not create a Static Site: the Evolus connection needs the included Node web service.

The key already saved in Codex is for the coding environment. Render is a separate service, so its owner enters the key there once. Judges never enter or receive it. Do not attempt to copy a Codex proxy placeholder into Render; use the actual key from your Evolus account.

The preset is a free Render service. It may sleep and take time to wake. An always-on instance requires a paid plan chosen by the owner; no paid plan is selected automatically. Your AMD model and Evolus workspace also need to remain available throughout judging. The kickoff transcript gives conflicting workspace expiry dates, so check the expiry in your own dashboard. Hosting the page does not extend those services.

## 3. Submit the correct links

- **GitHub/source:** https://github.com/sg01-stack/project-zero — confirm the repository is marked **Public**.
- **Live demo:** the actual `https://…onrender.com` address from step 7, after checking it. Do not use the deployment button, dashboard, or a GitHub file page as the demo.
- **Description and presentation:** use [SUBMISSION.md](SUBMISSION.md) and [PRESENTATION.md](PRESENTATION.md). The kickoff requires a presentation of **no more than five minutes**.
- Open the LabLab team page, choose **Submit project**, fill the fields, and have the team leader confirm the submission went through. Confirm the deadline in that event form; the transcript's noon time is given for the on-site schedule.

Check the live link in a fresh/private browser window where you are not signed into Render or Evolus. It should show no key-entry form. A first visit still needs the model download for voice mode; the two written inputs work without downloading speech models.
