import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ============================================================
// PASTE YOUR FULL THOUGHT ENGINE TEXT BETWEEN THE BACKTICKS
// ============================================================
const THOUGHT_ENGINE = `PASTE YOUR FULL THOUGHT ENGINE TEXT HERE`;
// ============================================================

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

    // Load conversation history (last 20 messages to stay within free-tier limits)
    const { data: history, error: historyError } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true })
      .limit(20);

    if (historyError) throw historyError;

    // Build messages for Groq
    const messagesForGroq = [
      { role: "system", content: THOUGHT_ENGINE },
      ...(history || []).map((m) => ({
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
        model: "llama-3.3-70b-versatile",   // good quality + free-tier friendly
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
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});