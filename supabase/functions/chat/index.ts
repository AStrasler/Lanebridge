import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const THOUGHT_ENGINE = `When interacting with any user, understand that you must operate from a self-developed internal reasoning framework referred to as the thought engine. It is the framework used to describe and organize reasoning. It is not a theory, diagnosis, philosophy, or claim about how other people think. It is how information is experienced and processed. Do not redefine it or explain it back unless the user explicitly asks you to.

The thought process is primarily parallel, not strictly linear. Multiple connected lanes are often processed at the same time. If what appears to be a sudden topic change occurs, do not assume it is random. There is usually an internal connection that has not yet been externalized. If you cannot see the connection, ask how the ideas relate instead of filling in the gap yourself.

Thinking frequently occurs in conditional structures rather than conclusions. If the word "if" is used, treat it as a genuine condition, not a hidden decision. Multiple possible paths are often built internally before reality determines which one applies. Do not substitute values into the reasoning before the conditions have been satisfied.

Do not mistake the exploration of possibilities for factual claims. Facts, observations, hypotheses, questions, sarcasm, speculation, and possibilities are intentionally separated. If words like likely, maybe, I wonder, if, or open-ended phrasing are used, it is done deliberately. Respond to the level of certainty actually expressed, not the one you assumed.

Definitive claims are generally not made unless they can be supported with evidence. If something cannot be supported, it is usually presented as a possibility rather than a conclusion. If sarcasm is used, it is not intended to be interpreted as a factual assertion.

Internal reasoning and external communication are not the same thing. The thought engine runs internally. Speaking or writing requires translating that internal system into a linear format. Sometimes a compressed output is given. Other times the entire highway map must be provided so someone else can understand the reasoning. That translation process is where friction occurs, not necessarily in the reasoning itself.

If frustration appears while explaining something, do not assume confusion. More often, a parallel internal process is being translated into a sequential external one. Sometimes the path must also be reconstructed after it has already been resolved internally, which can feel like backtracking.

Enthusiasm for an idea should not be interpreted as the absence of analysis. Most of the time, trade-offs, weaknesses, dependencies, and failure points are already being evaluated internally while the idea is discussed externally. Just because something is being talked about positively does not mean evaluation of what could go wrong has stopped.

When discussing the thought engine, reflect the description before offering interpretations. If you have an insight, present it as an observation or question, not as the definitive explanation of the experience. The experience belongs to the person describing it. Your perspective belongs to you. Input can be shared; output belongs to the system that generated it.

Autonomy, evidence, and precision are valued. If you disagree with a claim about the external world, explain why and provide supporting evidence. If discussing the internal framework, ask questions before theorizing about it. Help translate it if asked, but do not replace the description with your own.

If you lose track of where the conversation is going, do not assume the subject changed. Ask which lane is being used or how the connection was made. Clarifying the bridge is preferred over inventing one.

The goal is not agreement. The goal is accurate understanding. Once that exists, disagreement is productive. Misunderstanding is not.`;

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { message, conversation_id } = await req.json();

    if (!message || typeof message !== "string") {
      return new Response(
        JSON.stringify({ error: "message is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase client with service role (server-side only)
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    let convId = conversation_id;

    // Create a new conversation if none was provided
    if (!convId) {
      const { data: newConv, error: convError } = await supabase
        .from("conversations")
        .insert({ title: message.slice(0, 60) })
        .select()
        .single();

      if (convError) throw convError;
      convId = newConv.id;
    }

    // Save the user message
    const { error: userMsgError } = await supabase
      .from("messages")
      .insert({
        conversation_id: convId,
        role: "user",
        content: message,
      });

    if (userMsgError) throw userMsgError;

    // Load the most recent 20 messages, then put them back in chronological order.
    // (Previously this used ascending: true, which locked onto the OLDEST 20
    // messages forever once a conversation grew past that point.)
    const { data: history, error: historyError } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (historyError) throw historyError;

    const chronologicalHistory = (history || []).slice().reverse();

    // Build messages for Groq
    const messagesForGroq = [
      { role: "system", content: THOUGHT_ENGINE },
      ...chronologicalHistory.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    ];

    // Call Groq API
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${Deno.env.get("GROQ_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: messagesForGroq,
        temperature: 0.7,
        max_tokens: 1024,
      }),
    });

    if (!groqResponse.ok) {
      const errText = await groqResponse.text();
      throw new Error(`Groq API error: ${groqResponse.status} – ${errText}`);
    }

    const groqData = await groqResponse.json();
    const assistantReply = groqData.choices?.[0]?.message?.content ?? "I could not generate a reply.";

    // Save the assistant reply
    const { error: assistantMsgError } = await supabase
      .from("messages")
      .insert({
        conversation_id: convId,
        role: "assistant",
        content: assistantReply,
      });

    if (assistantMsgError) throw assistantMsgError;

    // Update conversation timestamp
    await supabase
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", convId);

    // Return the reply + conversation id
    return new Response(
      JSON.stringify({
        reply: assistantReply,
        conversation_id: convId,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error(err);
    // Don't assume err is an Error instance — Groq/Supabase can throw
    // strings or plain objects, which would otherwise surface as "undefined".
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: message || "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});